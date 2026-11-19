import base64
import gzip
import http.client
import importlib.util
import json
import sys
import unittest
from pathlib import Path
from queue import Queue
from threading import Thread
from unittest.mock import patch
from uuid import uuid4
from zlib import crc32


script = Path(__file__).resolve().parents[1] / "scripts" / "official-android-chat-probe.py"
spec = importlib.util.spec_from_file_location("android_probe", script)
probe_module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = probe_module
spec.loader.exec_module(probe_module)


def bytes_field(tag, value):
    size, encoded = len(value), bytearray()
    while size >= 128:
        encoded.append(size % 128 + 128)
        size //= 128
    return tag + encoded + bytes([size]) + value


def frame(payload, flags=0):
    return bytes([flags]) + len(payload).to_bytes(4, "big") + payload


class AndroidChatProbeTest(unittest.TestCase):
    def setUp(self):
        self.probe = probe_module.Probe({}, "")
        self.probe.token = "test"
        self.server = probe_module.ThreadingHTTPServer(("127.0.0.1", 0), probe_module.Handler)
        self.server.probe = self.probe
        thread = Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def post(self, path, body, *, compressed=False, authenticated=True):
        headers = {"Content-Type": "application/proto"}
        if authenticated:
            headers["Cookie"] = "sessionKey=" + self.probe.session
        if compressed:
            body = gzip.compress(body)
            headers["Content-Encoding"] = "gzip"
        return self.request("POST", path, body, headers)

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, response.getheader("Content-Type"), response.read()
        finally:
            connection.close()

    def serve_runner(self, status, mime, body):
        requests = []

        def rpc(method, request):
            requests.append((method, request))
            return {"status": status, "contentType": mime,
                    "body": {"$bytes": base64.b64encode(body).decode()}}

        self.probe.rpc = rpc
        return requests

    def test_image_upload_byte_limit_precedes_runner_transfer(self):
        path = f"/api/{self.probe.org}/upload"
        content_type = 'multipart/form-data; boundary="attachment-test"'
        response = (200, "application/json", b'{"file_kind":"image"}')
        calls = []

        def forward(method, path, content_type, body):
            calls.append((method, path, content_type, body))
            return response

        self.probe.forward_official = forward
        image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC")
        limit = 20 * 1024 * 1024

        def padded_png(size):
            extra = b"teSt" + b"x" * (size - len(image) - 12)
            return (image[:-12] + (len(extra) - 4).to_bytes(4, "big") + extra
                    + crc32(extra).to_bytes(4, "big") + image[-12:])

        def multipart(filename, data):
            return (b'--attachment-test\r\nContent-Disposition: form-data; name="client_upload_id"\r\n\r\ntest\r\n'
                    b'--attachment-test\r\nContent-Disposition: form-data; name="file"; filename="'
                    + filename.encode() + b'"\r\nContent-Type: application/octet-stream\r\n\r\n'
                    + data + b"\r\n--attachment-test--\r\n")

        headers = {"Cookie": "sessionKey=" + self.probe.session, "Content-Type": content_type}
        oversized = multipart("photo.PNG", padded_png(limit + 1))
        for data, encoding in ((oversized, {}), (gzip.compress(oversized), {"Content-Encoding": "gzip"})):
            with self.subTest(encoding=encoding):
                status, mime, error = self.request("POST", path, data, headers | encoding)
                self.assertEqual((status, mime), (413, "application/json"))
                self.assertEqual(json.loads(error)["error"]["type"], "invalid_request_error")
                self.assertEqual(len(calls), 0)

        exact = multipart("photo.PNG", padded_png(limit))
        self.assertEqual(self.request("POST", path, exact, headers), response)
        non_image = multipart("document.pdf", b"%PDF-" + b"x" * (limit - 4))
        self.assertEqual(self.request("POST", path, non_image, headers), response)
        self.assertEqual([call[:3] for call in calls], [("POST", path, content_type)] * 2)
        self.assertTrue(calls[0][3] == exact and calls[1][3] == non_image)

    def test_file_preview_reads_the_entire_runner_transfer(self):
        identifier = str(uuid4())
        path = f"/api/{self.probe.org}/files/{uuid4()}/preview"
        chunk_bytes = 2 * 1024 * 1024
        data = b"a" * chunk_bytes + b"b" * chunk_bytes + b"c" * 1024

        def result(status, mime, body, **transfer):
            return {"status": status, "contentType": mime,
                    "body": {"$bytes": base64.b64encode(body).decode()}, **transfer}

        def rpc(method, request):
            self.assertEqual(method, "officialUiRead")
            if request["path"] == path:
                if not request.get("responseTransfer"):
                    return result(413, "application/json", b'{"error":"The official Web response is too large."}')
                return result(200, "image/webp", data[:chunk_bytes],
                              responseTransfer={"id": identifier, "totalBytes": len(data)})
            offset = int(request["path"].rsplit("=", 1)[1])
            self.assertEqual(request, {"method": "GET", "path": f"/api/claudex/response_chunks/{identifier}?offset={offset}"})
            return result(200, "application/octet-stream", data[offset:offset + chunk_bytes], responseOffset=offset)

        self.probe.rpc = rpc
        headers = {"Cookie": "sessionKey=" + self.probe.session}
        status, mime, body = self.request("GET", path, headers=headers)
        self.assertEqual((status, mime), (200, "image/webp"))
        self.assertEqual(body, data)

    def test_defaults_forwards_an_empty_proto_body(self):
        requests = self.serve_runner(200, "application/proto", b"\x18\x02")
        self.assertEqual(self.post(probe_module.DEFAULTS_PATH, b""), (200, "application/proto", b"\x18\x02"))
        self.assertEqual(requests, [("officialUiRead", {"method": "POST", "path": probe_module.DEFAULTS_PATH,
                         "contentType": "application/proto", "body": {"$bytes": ""}})])

    def test_gzip_send_preserves_both_native_attachments_and_mutation(self):
        requests = self.serve_runner(200, "application/proto", b"\x0a\x02\x10\x01")
        self.probe.action_lease = lambda: "engine-chat-lease"
        mutation = bytes_field(b"\x0a", b"\x0a\x08test-tab\x10\x01")
        conversation_id = bytes_field(b"\x12", str(uuid4()).encode())
        capabilities = bytes_field(b"\x3a", b"\x58\x01\x90\x02\x01")
        supported_capabilities = bytes_field(b"\x3a", b"\x58\x01")
        message = bytes_field(b"\x1a", b"Read both files.")
        attachments = b"".join(bytes_field(b"\x7a", bytes_field(b"\x0a", name)
                                + bytes_field(b"\x22", content))
                               for name, content in [("路线.txt".encode(), "编号=甲".encode()),
                                                     (b"notes.md", b"ref=beta")])
        platform = b"\x90\x01\x04"
        native = (bytes_field(b"\x0a", mutation + conversation_id + capabilities)
                  + bytes_field(b"\x12", message + b"\x30\x01" + attachments + platform + b"\xb0\x02\x01"))
        expected = (bytes_field(b"\x0a", mutation + conversation_id + supported_capabilities)
                    + bytes_field(b"\x12", message + attachments + platform))
        self.assertEqual(self.post(probe_module.ACTION_PATH, native, compressed=True, authenticated=False)[0], 404)
        self.assertEqual(self.post(probe_module.ACTION_PATH, native, compressed=True),
                         (200, "application/proto", b"\x0a\x02\x10\x01"))
        self.assertEqual(requests, [("officialUiAction", {"method": "POST", "path": probe_module.ACTION_PATH,
                         "contentType": "application/proto", "capabilityLease": "engine-chat-lease",
                         "body": {"$bytes": base64.b64encode(expected).decode()}})])

    def test_conversation_read_projects_the_runner_timeline(self):
        identifier = str(uuid4()).encode()
        query = bytes_field(b"\x0a", identifier)
        update = bytes_field(b"\x12", bytes_field(b"\x0a", identifier))
        snapshot = bytes_field(b"\x0a", bytes_field(b"\x0a", update))
        requests = self.serve_runner(200, "application/connect+proto", b"\x00\x00\x00\x00" + bytes([len(snapshot)]) + snapshot)
        self.assertEqual(self.post(probe_module.READ_CONVERSATION_PATH, query + b"\x18\x80\x80\x80\x04"),
                         (200, "application/proto", b"\x08\x01" + bytes_field(b"\x12", update)))
        self.assertEqual(requests, [("officialUiRead", {"method": "POST", "path": probe_module.TIMELINE_PATH,
                         "contentType": "application/connect+proto",
                         "body": {"$bytes": base64.b64encode(b"\x00\x00\x00\x00\x26" + query).decode()}})])

    def test_oversize_decompressed_action_does_not_reach_runner(self):
        requests = self.serve_runner(200, "application/proto", b"")
        status, _, _ = self.post(probe_module.ACTION_PATH, b"x" * (5 * 1024 * 1024 + 1), compressed=True)
        self.assertEqual(status, 413)
        self.assertEqual(requests, [])

    def test_invalid_inline_text_returns_terminal_ack_without_dispatch(self):
        requests = self.serve_runner(200, "application/proto", b"")
        mutation = b"\x0a\x08test-tab\x10\x01"
        message_id = str(uuid4()).encode()
        for content, expected in ((b"a\0b", b"UTF-8 text"), (b"\xff", b"UTF-8 text"),
                                  (b"x" * (2 * 1024 * 1024 + 1), b"2 MiB")):
            with self.subTest(expected=expected):
                inline = bytes_field(b"\x7a", bytes_field(b"\x0a", b"invalid.txt") + bytes_field(b"\x22", content))
                native = (bytes_field(b"\x0a", bytes_field(b"\x0a", mutation))
                          + bytes_field(b"\x12", bytes_field(b"\x0a", message_id) + inline))
                status, mime, body = self.post(probe_module.ACTION_PATH, native, compressed=True)
                self.assertEqual((status, mime), (200, "application/proto"))
                ack = probe_module.proto_values(probe_module.proto_values(body)[1])
                self.assertEqual(ack[1], mutation)
                self.assertNotIn(2, ack)
                failure = probe_module.proto_values(ack[3])
                self.assertEqual(failure[2], message_id)
                self.assertEqual(failure[3], b"send_message")
                error = probe_module.proto_values(failure[1])
                self.assertIn(expected, error[3])
                self.assertEqual(error.get(4, 0), 0)
        self.assertEqual(requests, [])

    def test_missing_conversation_maps_to_connect_not_found(self):
        error = b"\x0a\x0d\x1a\x0b\x0a\x09not_found"
        self.serve_runner(200, "application/connect+proto", frame(error) + frame(b"{}", 2))
        status, mime, body = self.post(probe_module.READ_CONVERSATION_PATH, bytes_field(b"\x0a", str(uuid4()).encode()))
        self.assertEqual((status, mime, json.loads(body)["code"]), (404, "application/json", "not_found"))

    def test_native_code_creation_and_history_allow_the_original_followup(self):
        session = "session_" + "1" * 32
        wire_session = {"id": session, "last_event_at": "2026-11-14T00:00:00Z"}
        android_session = {**wire_session, "updated_at": wire_session["last_event_at"]}
        document, image = str(uuid4()), str(uuid4())
        seed = str(uuid4())
        headers = {"Cookie": "sessionKey=" + self.probe.session, "Content-Type": "application/json"}
        calls = []

        def forward(method, path, mime, body):
            calls.append((method, path, mime, json.loads(body) if body else None))
            response = {"data": [wire_session]} if method == "GET" and path == "/v1/code/sessions" else {"session": wire_session}
            return 200, "application/json", json.dumps(response).encode()

        self.probe.forward_official = forward
        native = {"type": "user", "uuid": seed,
                  "message": {"content": "Read both files."},
                  "file_attachments": [{"file_uuid": document, "file_name": "notes.txt"},
                                       {"file_uuid": image, "file_name": "diagram.png", "is_image": True,
                                        "image_width": 22, "image_height": 19}]}
        creation = {"environment_id": "default", "config": {"sources": [], "model": "fixture-code"}}
        status, _, body = self.request("POST", "/v1/code/sessions", json.dumps(creation), headers)
        self.assertEqual((status, json.loads(body)), (200, {"session": android_session}))
        self.assertEqual(calls[0][:3], ("POST", "/v1/code/sessions", "application/json"))
        self.assertEqual(calls[0][3]["config"], {"sources": [], "outcomes": [], "model": "fixture-code"})
        self.assertEqual(calls[0][3]["events"], [])

        followup = {"session_id": session, "events": [{"payload": native}]}
        self.assertEqual(self.request("POST", f"/v1/code/sessions/{session}/events",
                                      json.dumps(followup), headers)[0], 200)
        self.assertEqual(calls[1][3]["events"][0]["payload"], {
            "type": "user", "uuid": seed, "message": {"role": "user", **native["message"]}, "priority": "later",
            "file_attachments": [{"file_uuid": document, "file_name": "notes.txt", "is_image": False},
                                 {"file_uuid": image, "file_name": "diagram.png", "is_image": True}],
        })
        followup["events"][0]["payload"]["priority"] = "next"
        self.assertEqual(self.request("POST", f"/v1/code/sessions/{session}/events",
                                      json.dumps(followup), headers)[0], 200)
        self.assertEqual(calls[2][3]["events"][0]["payload"]["priority"], "next")
        self.assertEqual(json.loads(self.request("GET", f"/v1/code/sessions/{session}", headers=headers)[2]),
                         {"response_shape": android_session})
        self.assertEqual(json.loads(self.request("GET", "/v1/code/sessions", headers=headers)[2]),
                         {"data": [android_session]})

    def test_code_event_stream_replays_from_anchor_and_stop_stays_bound(self):
        session = "session_" + "1" * 32
        client_session = session.replace("session_", "cse_")
        path = "/v1/code/sessions/" + client_session + "/events"
        headers = {"Cookie": "sessionKey=" + self.probe.session}
        first_anchor = "evt_" + "a" * 64
        second_anchor = "evt_" + "b" * 64
        target = {"turnId": "running-turn", "threadId": "thread", "turnCreatedAt": 2, "conversationCreatedAt": 1}
        old_event = {"event_id": first_anchor, "sequence_num": 1, "payload": {"type": "result"}}
        user_event = {"event_id": second_anchor, "sequence_num": 2, "payload": {"type": "user"},
                      "processing_at": "2026-11-14T00:00:00Z"}
        turn = {"target": target, "promptUuid": str(uuid4())}
        next_turn = None
        forwarded = []
        current_events = []
        queries = Queue()
        events = object.__new__(probe_module.TimelineEvents)
        events.changed = probe_module.Condition()
        events.stopped = probe_module.Event()
        events.revision = 0
        events.connected = True
        self.probe.timeline_events = lambda: events
        self.addCleanup(events.close)

        def official(method, route):
            self.assertEqual(method, "GET")
            queries.put(route)
            if "from_sequence_num=1" in route:
                return 200, {"session": {"id": session, "claudex_stop_target": turn},
                             "data": [user_event], "has_more": False}
            return 200, {"session": {"id": session, "claudex_stop_target": next_turn},
                         "data": current_events, "has_more": False}

        def forward(method, route, mime, body):
            self.assertEqual(route, path)
            if method == "GET":
                return 200, "application/json", json.dumps({"data": [old_event]}).encode()
            forwarded.append(json.loads(body))
            return 200, "application/json", b'{}'

        self.probe.official = official
        self.probe.forward_official = forward
        self.assertEqual(self.request("GET", path, headers=headers)[0], 200)

        def stream(sequence):
            client = http.client.HTTPConnection(*self.server.server_address, timeout=4)
            self.addCleanup(client.close)
            client.request("GET", path + f"/stream?from_sequence_num={sequence}", headers=headers)
            response = client.getresponse()
            self.addCleanup(response.close)
            return response

        def receive(response):
            lines = []
            while (line := response.readline()) != b"\n":
                self.assertTrue(line)
                lines.append(line.decode().strip())
            return lines

        response = stream(1)
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(queries.get(timeout=1), path + "/stream?from_sequence_num=1&after_event_id=" + first_anchor)
        self.assertEqual(receive(response)[0], "event: session_update")
        self.assertEqual(receive(response)[0], "event: delivery_update")
        lines = receive(response)
        self.assertEqual(lines[:2], ["id: 2", "event: client_event"])
        self.assertEqual(json.loads(lines[2].removeprefix("data: ")), user_event)

        native_stop = {"session_id": client_session, "events": [{"payload": {
            "type": "control_request", "request_id": str(uuid4()), "request": {"subtype": "interrupt"},
        }}]}
        self.assertEqual(self.request("POST", path, json.dumps(native_stop), headers)[0], 200)
        self.assertEqual(forwarded[0]["events"][0]["payload"]["request"]["turn_target"], target)

        response.close()
        next_turn = {"target": {**target, "turnId": "new-turn"}, "promptUuid": str(uuid4())}
        response = stream(2)
        self.assertEqual(receive(response)[0], "event: session_update")
        self.assertEqual(queries.get(timeout=1), path + "/stream?from_sequence_num=2&after_event_id=" + second_anchor)
        self.assertEqual(self.request("POST", path, json.dumps(native_stop), headers)[0], 200)
        self.assertEqual(len(forwarded), 1)

        current_events = [{"event_id": "evt_" + "d" * 64, "sequence_num": 4, "payload": {"type": "result"}}]
        events.signal()
        self.assertEqual(queries.get(timeout=1), path + "/stream?from_sequence_num=2&after_event_id=" + second_anchor)
        with self.assertRaises(http.client.IncompleteRead) as failure:
            response.read()
        self.assertEqual(failure.exception.partial, b"")

    def test_native_code_queue_reopens_without_advancing_transcript_cursor(self):
        session = "session_" + "1" * 32
        events = f"/v1/code/sessions/{session}/events"
        headers = {"Cookie": "sessionKey=" + self.probe.session}
        identifier = str(uuid4())
        queue_event = "evt_" + "b" * 64
        time = "2026-11-14T00:00:00Z"
        pending = {"uuid": identifier, "state": "held", "event_id": queue_event}
        payload = {"type": "user", "uuid": identifier, "timestamp": time, "priority": "later",
                   "message": {"role": "user", "content": "Read it."},
                   "file_attachments": [{"file_uuid": str(uuid4()), "file_name": "queued.txt", "is_image": False}]}
        old = {"sequence_num": 1, "event_id": "evt_" + "a" * 64, "payload": {"type": "result"}}

        def official(method, path):
            self.assertEqual((method, path), ("GET", f"{events}/queue/{identifier}"))
            return 200, payload

        self.probe.official = official
        self.probe.forward_official = lambda *_: (200, "application/json", json.dumps({
            "data": [old], "next_cursor": "older-page", "queue": [pending],
        }).encode())
        status, _, body = self.request("GET", f"{events}?sort_order=desc", headers=headers)
        self.assertEqual(status, 200)
        page = json.loads(body)
        self.assertEqual(page["next_cursor"], "older-page")
        queued, durable = page["data"]
        self.assertEqual((queued["payload"], queued["event_id"], queued["sequence_num"]), (payload, queue_event, 0))
        self.assertEqual(durable, old)
        self.assertEqual(json.loads(self.request("GET", f"{events}?sort_order=desc&cursor=older-page",
                                                headers=headers)[2])["data"], [old])

        stream = probe_module.CodeStream(session, 1, old["event_id"])
        frames = list(stream.frames({"data": [], "has_more": False}, [queued]))
        self.assertEqual(frames, [probe_module.sse_frame("client_event", queued)])
        self.assertEqual((stream.sequence, stream.anchor), (1, old["event_id"]))
        claimed = {**queued, "sequence_num": 2, "processing_at": time}
        frames = list(stream.frames({"data": [claimed], "has_more": False}))
        self.assertEqual(frames, [probe_module.sse_frame("delivery_update", {
            "event_id": queue_event, "status": "processing", "timestamp": time}),
            probe_module.sse_frame("client_event", claimed, 2)])

    def test_native_code_send_now_can_claim_a_held_input_when_idle(self):
        session = "session_" + "1" * 32
        path = f"/v1/code/sessions/{session}/events"
        headers = {"Cookie": "sessionKey=" + self.probe.session, "Content-Type": "application/json"}
        received = []

        def forward(_method, _path, _mime, body):
            received.append(json.loads(body))
            return 200, "application/json", b'{}'

        def input_for(control):
            return json.dumps({"session_id": session, "events": [{"payload": {
                "type": "control_request", "request_id": str(uuid4()), "request": control,
            }}]})

        self.probe.forward_official = forward
        self.assertEqual(self.request("POST", path, input_for({"subtype": "interrupt"}), headers)[0], 409)
        send_now = input_for({"subtype": "interrupt", "queued_message_uuid": str(uuid4())})
        for _ in range(2):
            self.assertEqual(self.request("POST", path, send_now, headers)[0], 200)
        self.assertEqual(received, [json.loads(send_now)])

    def test_connect_timeline_streams_updates_and_reconnects_after_relay_loss(self):
        from websockets.sync.server import serve

        connections = Queue()
        tickets = []
        identifier = str(uuid4()).encode()
        updates = Queue()
        reads = Queue()
        current = b""
        version = 0

        def accept(connection):
            hello = json.loads(connection.recv(timeout=3))
            connections.put((connection, hello))
            for raw in connection:
                if json.loads(raw)["t"] == "ping":
                    connection.send('{"t":"pong"}')

        relay = serve(accept, "127.0.0.1", 0, subprotocols=["claudex.v1"])
        worker = Thread(target=relay.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join)
        self.addCleanup(relay.shutdown)
        self.addCleanup(lambda: self.probe.events.close() if self.probe.events else None)
        self.probe.backend = "http://127.0.0.1:" + str(relay.socket.getsockname()[1])

        def ticket(path, body):
            tickets.append((path, body))
            return {"data": {"ticket": "isolation-ticket"}}

        def official(method, path, mime, payload):
            nonlocal current, version
            self.assertEqual((method, path, mime), ("POST", probe_module.TIMELINE_PATH, "application/connect+proto"))
            self.assertEqual(payload, frame(query))
            while not updates.empty():
                current = updates.get_nowait()
            version += 1
            reads.put(current)
            if not current:
                return 200, mime, frame(b"\x0a\x0d\x1a\x0b\x0a\x09not_found") + frame(b"{}", 2)
            update = b"\x08\x01" + bytes_field(b"\x12", bytes_field(b"\x0a", identifier)) + bytes_field(b"\x2a", current)
            event = bytes_field(b"\x0a", update) + bytes_field(b"\x52", bytes_field(b"\x0a", str(version).encode())) + b"\x58\x01"
            return 200, mime, frame(bytes_field(b"\x0a", event))

        def stream():
            client = http.client.HTTPConnection(*self.server.server_address, timeout=4)
            self.addCleanup(client.close)
            client.request("POST", probe_module.TIMELINE_PATH, [frame(gzip.compress(query), 1)], {
                "Content-Type": "application/connect+proto", "Cookie": "sessionKey=" + self.probe.session,
            }, encode_chunked=True)
            return client

        def receive(response, flags=0):
            header = response.read(5)
            self.assertEqual(len(header), 5)
            self.assertEqual(header[0], flags)
            return response.read(int.from_bytes(header[1:], "big"))

        def send(connection, kind, seq, **fields):
            connection.send(json.dumps({"t": kind, "seq": seq, **fields}))

        self.probe.post = ticket
        self.probe.official_response = official
        query = bytes_field(b"\x0a", identifier) + b"\x18\x01"
        with patch.object(probe_module, "TIMELINE_HEARTBEAT_SECONDS", 0.25):
            client = stream()
            socket, hello = connections.get(timeout=3)
            self.assertEqual(hello, {"t": "hello", "v": 1, "tabId": self.probe.tab})
            self.assertIn("ticket.isolation-ticket", socket.request.headers["Sec-WebSocket-Protocol"])
            send(socket, "ready", 100, resumed=False)
            response = client.getresponse()
            self.assertEqual((response.status, response.getheader("Transfer-Encoding")), (200, "chunked"))
            self.assertEqual(reads.get(timeout=1), b"")
            self.assertIn(b"\x32", receive(response))

            updates.put(b"A")
            send(socket, "event", 101, event={"type": "conversation", "conversation": {"id": str(uuid4())}})
            self.assertIn(b"\x2a\x01A", receive(response))
            self.assertEqual(reads.get(timeout=1), b"A")
            send(socket, "event", 101, event={"type": "conversation-turn"})
            send(socket, "event", 102, event={"type": "conversation-turn"})
            self.assertEqual(reads.get(timeout=1), b"A")
            self.assertIn(b"\x32\x02\x08\x01", receive(response))

            socket.close()
            updates.put(b"A B")
            replacement, hello = connections.get(timeout=3)
            self.assertEqual(hello["lastSeq"], 102)
            send(replacement, "ready", 103, resumed=True)
            send(replacement, "event", 103, event={"type": "conversation-turn"})
            payload = receive(response)
            while payload.startswith(b"\x0a\x04\x32"):
                payload = receive(response)
            self.assertIn(b"\x2a\x03A B", payload)
            self.assertEqual(tickets, [(probe_module.EVENTS_ROOT + "/auth/events-ticket", {"tabId": self.probe.tab})] * 2)

            client.close()
            query += bytes_field(b"\x12", bytes_field(b"\x0a", b"native-resume-version")) + b"\x30\x01"
            updates.put(b"A B C")
            reopened = stream().getresponse()
            self.assertIn(b"\x2a\x05A B C", receive(reopened))
            replacement.close()

    def test_native_replays_and_stop_keep_their_runner_mutation_identity(self):
        requests = self.serve_runner(200, "application/proto", b"\x0a\x02\x10\x01")
        self.probe.action_lease = lambda: "engine-chat-lease"
        conversation = bytes_field(b"\x12", str(uuid4()).encode())
        user = bytes_field(b"\x0a", str(uuid4()).encode())
        assistant = str(uuid4()).encode()

        def header(version):
            mutation = b"\x0a\x08test-tab\x10" + bytes([version])
            return bytes_field(b"\x0a", bytes_field(b"\x0a", mutation) + conversation)

        send = header(1) + bytes_field(b"\x12", user + bytes_field(b"\x12", assistant) + bytes_field(b"\x1a", b"reply"))
        stop = header(2) + bytes_field(b"\x1a", bytes_field(b"\x0a", assistant) + b"\x10\x01")
        for action in (send, send, stop):
            self.assertEqual(self.post(probe_module.ACTION_PATH, action, compressed=True)[0], 200)
        self.assertEqual([name for name, _ in requests], ["officialUiAction"] * 3)
        self.assertEqual([base64.b64decode(request["body"]["$bytes"]) for _, request in requests], [send, send, stop])


if __name__ == "__main__":
    unittest.main()
