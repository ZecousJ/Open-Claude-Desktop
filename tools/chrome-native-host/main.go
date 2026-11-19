package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

const extensionOrigin = "chrome-extension://ihinfgaomlffmklfhabkikjhlbehmekf/"
const maxHandshakeSize = 4096

type descriptor struct {
	Port int    `json:"port"`
	Key  string `json:"key"`
}

type handshake struct {
	Type  string `json:"type"`
	Nonce string `json:"nonce"`
	Proof string `json:"proof,omitempty"`
}

func readFrame(reader io.Reader, target any) error {
	var size uint32
	if err := binary.Read(reader, binary.LittleEndian, &size); err != nil {
		return err
	}
	if size == 0 || size > maxHandshakeSize {
		return errors.New("invalid pairing message size")
	}
	frame := make([]byte, size)
	if _, err := io.ReadFull(reader, frame); err != nil {
		return err
	}
	return json.Unmarshal(frame, target)
}

func writeFrame(writer io.Writer, message handshake) error {
	frame, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if err := binary.Write(writer, binary.LittleEndian, uint32(len(frame))); err != nil {
		return err
	}
	_, err = writer.Write(frame)
	return err
}

func proof(key []byte, peer, hostNonce, desktopNonce string) []byte {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "claudex-chrome-v1:%s:%s:%s", peer, hostNonce, desktopNonce)
	return mac.Sum(nil)
}

func authenticate(conn net.Conn, key []byte) error {
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	hostNonce := base64.RawURLEncoding.EncodeToString(nonce)
	if err := writeFrame(conn, handshake{Type: "hello", Nonce: hostNonce}); err != nil {
		return err
	}
	var reply handshake
	if err := readFrame(conn, &reply); err != nil {
		return err
	}
	desktopNonce, nonceErr := base64.RawURLEncoding.DecodeString(reply.Nonce)
	desktopProof, proofErr := base64.RawURLEncoding.DecodeString(reply.Proof)
	if reply.Type != "challenge" || nonceErr != nil || len(desktopNonce) != 32 || proofErr != nil ||
		!hmac.Equal(desktopProof, proof(key, "desktop", hostNonce, reply.Nonce)) {
		return errors.New("could not authenticate Claudex Desktop")
	}
	return writeFrame(conn, handshake{
		Type:  "confirm",
		Nonce: reply.Nonce,
		Proof: base64.RawURLEncoding.EncodeToString(proof(key, "host", hostNonce, reply.Nonce)),
	})
}

func run() error {
	if len(os.Args) < 2 || os.Args[1] != extensionOrigin {
		return errors.New("unexpected Chrome extension origin")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	configuration, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "chrome-bridge.json"))
	if err != nil {
		return errors.New("open Claudex Desktop before sharing a tab")
	}
	var endpoint descriptor
	if err := json.Unmarshal(configuration, &endpoint); err != nil {
		return err
	}
	key, err := base64.RawURLEncoding.DecodeString(endpoint.Key)
	if err != nil || len(key) != 32 || endpoint.Port < 1 || endpoint.Port > 65535 {
		return errors.New("invalid Claudex Desktop connection")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(endpoint.Port)), 3*time.Second)
	if err != nil {
		return errors.New("could not reach Claudex Desktop")
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if err := authenticate(conn, key); err != nil {
		return err
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return err
	}
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		_ = conn.Close()
	}()
	_, err = io.Copy(os.Stdout, conn)
	if errors.Is(err, net.ErrClosed) {
		return nil
	}
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
