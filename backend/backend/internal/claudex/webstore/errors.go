package webstore

import (
	"errors"
	"fmt"

	"github.com/Wei-Shaw/sub2api/internal/claudex/webproto"
)

// ErrCodeNotFound answers an op or download about a row the user does not
// have (another user's row looks exactly the same: not found).
const ErrCodeNotFound = "CLAUDEX_WEB_NOT_FOUND"

// OpError is a refused store op: a plain English message and a CLAUDEX_*
// code, sent back to the runner as the link response's error.
type OpError struct {
	Code    string
	Message string
	cause   error
}

func (e *OpError) Error() string {
	if e.cause != nil {
		return e.Code + ": " + e.Message + ": " + e.cause.Error()
	}
	return e.Code + ": " + e.Message
}

func (e *OpError) Unwrap() error { return e.cause }

// RPCError is the error of the link response frame.
func (e *OpError) RPCError() *webproto.RPCError {
	return &webproto.RPCError{Code: e.Code, Message: e.Message}
}

func badRequest(format string, args ...any) *OpError {
	return &OpError{Code: webproto.ErrCodeBadRequest, Message: fmt.Sprintf(format, args...)}
}

func notFound(what string) *OpError {
	return &OpError{Code: ErrCodeNotFound, Message: "This " + what + " doesn't exist."}
}

func tooLarge(what string) *OpError {
	return &OpError{Code: webproto.ErrCodeTooLarge, Message: "This " + what + " is too large to store."}
}

func quotaExceeded() *OpError {
	return &OpError{Code: webproto.ErrCodeQuotaExceeded, Message: "Your storage is full. Delete some conversations or files to make room."}
}

func failed(err error) *OpError {
	return &OpError{Code: webproto.ErrCodeHandlerFailed, Message: "The Claudex service couldn't save or read your data. Try again.", cause: err}
}

// asOpError turns any error into an OpError (internal errors keep their
// cause for the log, never for the answer).
func asOpError(err error) *OpError {
	if err == nil {
		return nil
	}
	var op *OpError
	if errors.As(err, &op) {
		return op
	}
	return failed(err)
}
