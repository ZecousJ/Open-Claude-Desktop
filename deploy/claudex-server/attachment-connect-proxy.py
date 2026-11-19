import os
import selectors
import socket
import socketserver
import sys

ALLOWED = {"cn-nb1.rains3.com", "claudex-attachments.cn-nb1.rains3.com"}


class Connection(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(10)
        line = self.rfile.readline(1025).decode("ascii", errors="replace").split()
        if len(line) != 3 or line[0] != "CONNECT" or not line[1].endswith(":443"):
            return
        host = line[1][:-4]
        if host not in ALLOWED:
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        for _ in range(64):
            header = self.rfile.readline(4097)
            if header in (b"", b"\n", b"\r\n"):
                break
        else:
            return
        try:
            peer = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            peer.settimeout(10)
            if interface := os.environ.get("CLAUDEX_ATTACHMENT_PROXY_INTERFACE"):
                peer.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex(interface))
            peer.connect((host, 443))
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return
        with peer, selectors.DefaultSelector() as selector:
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.connection.settimeout(20)
            peer.settimeout(20)
            selector.register(self.connection, selectors.EVENT_READ, peer)
            selector.register(peer, selectors.EVENT_READ, self.connection)
            while ready := selector.select(65):
                for event, _ in ready:
                    try:
                        packet = event.fileobj.recv(65536)
                        if not packet:
                            return
                        event.data.sendall(packet)
                    except OSError:
                        return


if __name__ == "__main__":
    with socketserver.ThreadingTCPServer(("127.0.0.1", int(sys.argv[1])), Connection) as server:
        server.daemon_threads = True
        server.serve_forever()
