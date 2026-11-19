package attachmentstore

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	uploadTTL = 15 * time.Minute
	readTTL   = 2 * time.Minute
)

type Store struct {
	client      *s3.Client
	transport   *http.Transport
	credentials aws.Credentials
	region      string
	bucket      string
	origin      *url.URL
}

// Origin is the endpoint browsers use to transfer attachments directly.
func Origin() string {
	endpoint, bucket := os.Getenv("CLAUDEX_ATTACHMENTS_S3_ENDPOINT"), os.Getenv("CLAUDEX_ATTACHMENTS_S3_BUCKET")
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Host != u.Hostname() ||
		u.User != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" ||
		bucket == "" || strings.Trim(bucket, "abcdefghijklmnopqrstuvwxyz0123456789-") != "" {
		return ""
	}
	return "https://" + bucket + "." + u.Host
}

func FromEnvironment() (*Store, error) {
	if os.Getenv("CLAUDEX_ATTACHMENTS_S3_BUCKET") == "" {
		return nil, nil
	}
	origin, _ := url.Parse(Origin())
	region := os.Getenv("CLAUDEX_ATTACHMENTS_S3_REGION")
	keys := aws.Credentials{
		AccessKeyID:     os.Getenv("CLAUDEX_ATTACHMENTS_S3_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("CLAUDEX_ATTACHMENTS_S3_SECRET_ACCESS_KEY"),
	}
	if origin == nil || origin.Host == "" || region == "" || !keys.HasKeys() {
		return nil, fmt.Errorf("attachment object storage configuration is incomplete")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if address := os.Getenv("CLAUDEX_ATTACHMENTS_S3_PROXY"); address != "" {
		proxy, err := url.Parse(address)
		if err != nil || proxy.Host == "" || (proxy.Scheme != "http" && proxy.Scheme != "https" &&
			proxy.Scheme != "socks5" && proxy.Scheme != "socks5h") {
			return nil, fmt.Errorf("attachment object storage proxy is invalid")
		}
		transport.Proxy = http.ProxyURL(proxy)
	}
	client := s3.New(s3.Options{
		BaseEndpoint:               aws.String(os.Getenv("CLAUDEX_ATTACHMENTS_S3_ENDPOINT")),
		UsePathStyle:               true,
		Region:                     region,
		Credentials:                aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) { return keys, nil }),
		HTTPClient:                 &http.Client{Transport: transport},
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return &Store{client: client, transport: transport, credentials: keys, region: region,
		bucket: os.Getenv("CLAUDEX_ATTACHMENTS_S3_BUCKET"), origin: origin}, nil
}

func Key(userID int64, fileID string) string {
	return "files/" + strconv.FormatInt(userID, 10) + "/" + fileID
}

type Upload struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

func (s *Store) sign(ctx context.Context, method, key, checksum string, expire time.Duration, params url.Values, headers http.Header) (string, error) {
	u := *s.origin
	u.Path = "/" + key
	params.Set("X-Amz-Expires", strconv.FormatInt(int64(expire/time.Second), 10))
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, method, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header = headers
	if raw := headers.Get("Content-Length"); raw != "" {
		req.ContentLength, _ = strconv.ParseInt(raw, 10, 64)
	}
	address, _, err := v4.NewSigner().PresignHTTP(ctx, s.credentials, req, checksum, "s3", s.region, time.Now(), func(o *v4.SignerOptions) {
		o.DisableHeaderHoisting = true
	})
	return address, err
}

func (s *Store) UploadURL(ctx context.Context, key string, size int64, sha string) (Upload, error) {
	headers := http.Header{
		"Content-Length":       {strconv.FormatInt(size, 10)},
		"If-None-Match":        {"*"},
		"X-Amz-Content-Sha256": {sha},
	}
	address, err := s.sign(ctx, http.MethodPut, key, sha, uploadTTL, url.Values{}, headers)
	return Upload{URL: address, Headers: map[string]string{"If-None-Match": "*", "X-Amz-Content-Sha256": sha}}, err
}

func (s *Store) DownloadURL(ctx context.Context, key, contentType, disposition string) (string, error) {
	params := url.Values{"response-cache-control": {"private, no-store"}}
	if contentType != "" {
		params.Set("response-content-type", contentType)
	}
	if disposition != "" {
		params.Set("response-content-disposition", disposition)
	}
	return s.sign(ctx, http.MethodGet, key, "UNSIGNED-PAYLOAD", readTTL, params, http.Header{})
}

func (s *Store) Size(ctx context.Context, key string) (int64, error) {
	info, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return 0, err
	}
	if info.ContentLength == nil {
		return 0, fmt.Errorf("object size is missing")
	}
	return *info.ContentLength, nil
}

func (s *Store) Open(ctx context.Context, key, byteRange string) (io.ReadCloser, error) {
	input := &s3.GetObjectInput{Bucket: &s.bucket, Key: &key}
	if byteRange != "" {
		input.Range = &byteRange
	}
	body, err := s.client.GetObject(ctx, input)
	if err != nil {
		return nil, err
	}
	return body.Body, nil
}

func (s *Store) CopyFrom(ctx context.Context, key string, body io.Reader, size int64, sha string) error {
	target, err := s.UploadURL(ctx, key, size, sha)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target.URL, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	for name, value := range target.Headers {
		req.Header.Set(name, value)
	}
	res, err := s.transport.RoundTrip(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusPreconditionFailed {
		return fmt.Errorf("attachment copy returned HTTP %d", res.StatusCode)
	}
	return nil
}

func (s *Store) Delete(ctx context.Context, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key})
	return err
}
