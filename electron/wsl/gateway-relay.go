package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"sync/atomic"
)

type frame struct {
	Kind string `json:"kind"`
	ID   uint32 `json:"id,omitempty"`
	Port int    `json:"port,omitempty"`
	Data []byte `json:"data,omitempty"`
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return err
	}
	defer listener.Close()
	encoder := json.NewEncoder(os.Stdout)
	var output sync.Mutex
	send := func(msg frame) bool {
		output.Lock()
		defer output.Unlock()
		return encoder.Encode(msg) == nil
	}
	if !send(frame{Kind: "ready", Port: listener.Addr().(*net.TCPAddr).Port}) {
		return io.ErrClosedPipe
	}

	var next atomic.Uint32
	var connections sync.Map
	go func() {
		for {
			conn, err := listener.AcceptTCP()
			if err != nil {
				return
			}
			id := next.Add(1)
			connections.Store(id, conn)
			go func() {
				if !send(frame{Kind: "open", ID: id}) {
					conn.Close()
					return
				}
				buf := make([]byte, 32*1024)
				for {
					n, err := conn.Read(buf)
					if n > 0 && !send(frame{Kind: "data", ID: id, Data: buf[:n]}) {
						conn.Close()
						return
					}
					if errors.Is(err, io.EOF) {
						send(frame{Kind: "end", ID: id})
						return
					}
					if err != nil {
						connections.Delete(id)
						conn.Close()
						send(frame{Kind: "close", ID: id})
						return
					}
				}
			}()
		}
	}()

	decoder := json.NewDecoder(os.Stdin)
	for {
		var msg frame
		if err := decoder.Decode(&msg); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		found, ok := connections.Load(msg.ID)
		if !ok {
			continue
		}
		conn := found.(*net.TCPConn)
		switch msg.Kind {
		case "data":
			if _, err := conn.Write(msg.Data); err != nil {
				connections.Delete(msg.ID)
				conn.Close()
				send(frame{Kind: "close", ID: msg.ID})
			}
		case "end":
			conn.CloseWrite()
		case "close":
			connections.Delete(msg.ID)
			conn.Close()
		}
	}
}
