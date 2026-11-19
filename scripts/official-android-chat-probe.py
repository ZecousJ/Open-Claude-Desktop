#!/usr/bin/env python3
"""Connect a loopback Android reconstruction to one Claudex acceptance account."""

from __future__ import annotations

import argparse
import base64
import gzip
import io
import json
import re
import secrets
import select
import socket
import time
from concurrent.futures import Future, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Condition, Event, Lock, Thread
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit
from urllib.request import Request, urlopen
from uuid import UUID, uuid4


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def uuid(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        return None


TIMELINE_PATH = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline"
DEFAULTS_PATH = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/GetNewConversationDefaults"
READ_CONVERSATION_PATH = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/ReadConversation"
ACTION_PATH = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction"
ACTION_MAX_BYTES = 5 * 1024 * 1024
TEXT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024
IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024
IMAGE_ATTACHMENT_SUFFIXES = {".gif", ".jpeg", ".jpg", ".png", ".webp"}
CHAT_UPLOAD_MAX_BYTES = 30 * 1024 * 1024 + 64 * 1024
MAX_CHAT_ATTACHMENTS = 12
FILE_RESPONSE_CHUNK_BYTES = 2 * 1024 * 1024
FILE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024
EVENTS_ROOT = "/api/v1/claudex/web"
TIMELINE_HEARTBEAT_SECONDS = 25
TIMELINE_OPEN_SECONDS = 10
TIMELINE_CREATE_SECONDS = 45
TIMELINE_CLOSE_CHECK_SECONDS = 1
TIMELINE_EVENTS = {"conversation", "conversation-turn", "approval", "approval-resolved",
                   "research", "settings", "policy", "resync"}
CODE_SESSIONS = "/v1/code/sessions"
CODE_SESSION_ROUTE = re.compile(r"/v1/code/sessions/((?:session|cse)_[a-f0-9]{32})(/events(?:/stream)?)?")
CODE_QUEUED_ROUTE = re.compile(r"/v1/code/sessions/(?:session|cse)_[a-f0-9]{32}/events/queue/[a-f0-9-]{36}")
CODE_HEARTBEAT_SECONDS = 12
CODE_INPUT_MAX_BYTES = 4 * 1024 * 1024 - 64 * 1024

SEND_EFFORTS = {"low", "medium", "high", "xhigh", "max", "ultra"}


class ModelSelectionError(ValueError):
    pass


def oversized_image_upload(body, content_type):
    if len(body) <= IMAGE_ATTACHMENT_MAX_BYTES:
        return False
    form = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\n\r\n" + body)
    for part in form.iter_parts():
        filename = part.get_filename()
        if filename is not None and part.get_content_disposition() == "form-data":
            return (Path(filename.strip()).suffix.lower() in IMAGE_ATTACHMENT_SUFFIXES
                    and len(part.get_payload(decode=True) or b"") > IMAGE_ATTACHMENT_MAX_BYTES)
    return False


def read_varint(stream):
    value = 0
    for shift in range(0, 64, 7):
        byte = stream.read(1)
        if not byte:
            break
        value |= (byte[0] & 127) << shift
        if byte[0] < 128:
            return value
    raise ValueError("Invalid protobuf varint")


def proto_varint(value):
    encoded = bytearray()
    while value >= 128:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def proto_bytes(field, data):
    return proto_varint((field << 3) | 2) + proto_varint(len(data)) + data


def proto_integer(field, value):
    return proto_varint(field << 3) + proto_varint(value)


def connect_frame(payload, flags=0):
    return bytes([flags]) + len(payload).to_bytes(4, "big") + payload


def timeline_frame(data):
    if len(data) < 5 or data[0] != 0:
        raise ValueError("Invalid Claudex conversation timeline frame")
    end = 5 + int.from_bytes(data[1:5], "big")
    if end > len(data):
        raise ValueError("Incomplete Claudex conversation timeline frame")
    return data[:end], proto_values(proto_values(data[5:end])[1])


def proto_fields(data):
    stream = io.BytesIO(data)
    while stream.tell() < len(data):
        start = stream.tell()
        tag = read_varint(stream)
        wire_type = tag & 7
        if wire_type == 0:
            value = read_varint(stream)
        elif wire_type == 2:
            length = read_varint(stream)
            if length > len(data) - stream.tell():
                raise ValueError("Incomplete protobuf field")
            value = stream.read(length)
        else:
            raise ValueError("Unsupported protobuf wire type")
        yield tag >> 3, value, data[start:stream.tell()]


def proto_values(data):
    return {field: value for field, value, _ in proto_fields(data)}


def runner_action(body):
    def header(data):
        android_display_flags = {34, 35, 36, 38, 39, 41, 42, 43}
        return b"".join(
            proto_bytes(7, b"".join(flag for number, _, flag in proto_fields(value)
                                    if number not in android_display_flags))
            if field == 7 else raw for field, value, raw in proto_fields(data)
        )

    def send_message(data):
        # The Runner uses the default input mode for typed text and the permission in settings_update.
        return b"".join(raw for field, value, raw in proto_fields(data)
                        if (field, value) != (6, 1) and field != 38)

    transforms = {1: header, 2: send_message}
    return b"".join(proto_bytes(field, transforms[field](value)) if field in transforms else raw
                    for field, value, raw in proto_fields(body))


def attachment_refusal(body):
    action = proto_values(body)
    if 2 not in action:
        return None
    attachments = [(field, value) for field, value, _ in proto_fields(action[2]) if field in (4, 15)]
    if len(attachments) > MAX_CHAT_ATTACHMENTS:
        message = "Attach at most 12 files to this message."
    else:
        for field, value in attachments:
            if field != 15:
                continue
            content = proto_values(value).get(4, b"")
            if len(content) > TEXT_ATTACHMENT_MAX_BYTES:
                message = "Text attachments can’t be larger than 2 MiB."
                break
            try:
                content.decode("utf-8")
                if b"\0" not in content:
                    continue
            except UnicodeDecodeError:
                pass
            message = "Text attachments must contain UTF-8 text, not binary data."
            break
        else:
            return None
    mutation = proto_values(action[1])[1]
    message_id = proto_values(action[2])[1]
    display = message.encode("utf-8")
    stream_error = (proto_bytes(1, b"invalid_request_error") + proto_bytes(2, display)
                    + proto_bytes(3, display) + proto_bytes(7, b""))
    mutation_error = proto_bytes(1, stream_error) + proto_bytes(2, message_id) + proto_bytes(3, b"send_message")
    return proto_bytes(1, proto_bytes(1, mutation) + proto_bytes(3, mutation_error))


def native_selector_state(state):
    def thinking(value):
        return {"type": "effort", "effort": value["effort"]} if value and value.get("effort") in SEND_EFFORTS else {"type": "none"}

    return {
        "id": state["id"], "model": state["model"], "thinking": thinking(state.get("thinking")),
        "thinking_by_model": [{"id": row["id"], "thinking": thinking(row.get("thinking"))}
                              for row in state.get("thinking_by_model", [])],
    }


def sse_frame(event, payload, sequence=None):
    identifier = f"id: {sequence}\n" if sequence is not None else ""
    return f"{identifier}event: {event}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n".encode()


def normalize_code_events(events):
    if not isinstance(events, list) or any(
        not isinstance(event, dict) or not isinstance(event.get("payload"), dict) for event in events
    ):
        raise ValueError("Invalid Code events")
    for event in events:
        event.pop("device_attestation", None)
        payload = event["payload"]
        if payload.get("type") == "control_request" and payload.get("parent_tool_use_id") is None:
            payload.pop("parent_tool_use_id", None)
        if payload.get("type") != "user":
            continue
        if payload.get("priority") is None:
            payload["priority"] = "later"
        if isinstance(payload.get("message"), dict):
            payload["message"].setdefault("role", "user")
        for file in payload.get("file_attachments") or []:
            if not isinstance(file, dict):
                raise ValueError("Invalid Code attachment")
            for key in ("image_width", "image_height"):
                file.pop(key, None)
            file.setdefault("is_image", False)
    return events


def android_code_session(session):
    return {**session, "updated_at": session["last_event_at"]}


@dataclass
class CodeSession:
    anchors: dict = field(default_factory=dict)
    stop_target: dict | None = None
    stops: dict = field(default_factory=dict)
    controls: list = field(default_factory=list)

    def remember(self, sequence, event_id):
        self.anchors[sequence] = event_id
        if len(self.anchors) > 100:
            del self.anchors[next(iter(self.anchors))]


@dataclass
class CodeStream:
    session: str
    sequence: int
    anchor: str | None = None
    preview: tuple | None = None
    delivered: set = field(default_factory=set)
    queued: set = field(default_factory=set)

    def query(self, path):
        cursor = {"from_sequence_num": self.sequence}
        if self.anchor:
            cursor["after_event_id"] = self.anchor
        return path + "?" + urlencode(cursor)

    def frames(self, batch, pending=()):
        if self.preview and batch["data"]:
            yield from self.preview_frames({**batch, "partial": {}, "tools": []})
        for entry in batch.get("processedQueue", []):
            if entry["event_id"] in self.delivered:
                continue
            self.delivered.add(entry["event_id"])
            yield sse_frame("delivery_update", {"event_id": entry["event_id"], "status": "processing",
                                               "timestamp": entry["timestamp"]})
        for event in batch["data"]:
            if event["sequence_num"] != self.sequence + 1:
                raise ValueError("Claudex Code stream skipped an event")
            self.sequence = event["sequence_num"]
            self.anchor = event["event_id"]
            if event["payload"]["type"] == "user" and "processing_at" in event:
                self.delivered.add(self.anchor)
                yield sse_frame("delivery_update", {"event_id": self.anchor, "status": "processing",
                                                   "timestamp": event["processing_at"]})
            yield sse_frame("client_event", event, self.sequence)
        if not batch["has_more"]:
            for event in pending:
                self.queued.add(event["event_id"])
                yield sse_frame("client_event", event)
            yield from self.preview_frames(batch)

    def preview_frames(self, batch):
        def ephemeral(event):
            return sse_frame("ephemeral_event", {"event_type": "stream_event", "payload": {
                "type": "stream_event", "session_id": self.session, "parent_tool_use_id": None, "event": event,
            }})

        partial = batch.get("partial", {})
        tools = batch.get("tools", [])
        identifier = f"{tools[0]['id']}:use" if tools else partial.get("id")
        text = partial.get("text", "")
        kind = partial.get("kind", "text")
        previous_id, previous_kind, previous_text, previous_tools = self.preview or (None, None, "", [])
        if self.preview and (identifier != previous_id or kind != previous_kind or
                             not text.startswith(previous_text) or tools[:len(previous_tools)] != previous_tools or
                             (text and not previous_text and previous_tools)):
            if previous_text:
                yield ephemeral({"type": "content_block_stop", "index": 0})
            yield ephemeral({"type": "message_stop"})
            previous_id, previous_text, previous_tools = None, "", []
        self.preview = (identifier, kind, text, tools) if identifier else None
        if not identifier:
            return
        if previous_id is None:
            yield ephemeral({"type": "message_start", "message": {"id": identifier, "type": "message",
                             "role": "assistant", "model": batch["session"].get("config", {}).get("model"), "content": []}})
        if text and not previous_text:
            yield ephemeral({"type": "content_block_start", "index": 0, "content_block": {"type": kind, kind: ""}})
        if delta := text[len(previous_text):]:
            yield ephemeral({"type": "content_block_delta", "index": 0, "delta": {"type": kind + "_delta", kind: delta}})
        for index, tool in enumerate(tools[len(previous_tools):], start=len(previous_tools) + bool(text)):
            yield ephemeral({"type": "content_block_start", "index": index, "content_block": {
                "type": "tool_use", "id": tool["id"], "name": tool["name"], "input": {},
            }})
            yield ephemeral({"type": "content_block_delta", "index": index, "delta": {
                "type": "input_json_delta", "partial_json": tool["inputJson"],
            }})
            yield ephemeral({"type": "content_block_stop", "index": index})


@dataclass
class Completion:
    conversation_id: str
    target: Future = field(default_factory=Future, init=False)
    finished: bool = field(default=False, init=False)
    stop_requested: bool = field(default=False, init=False)


class TimelineEvents:
    def __init__(self, probe):
        self.probe = probe
        self.changed = Condition()
        self.stopped = Event()
        self.revision = 0
        self.connected = False
        self.last_seq = None
        Thread(target=self.run, daemon=True).start()

    def signal(self, connected=None):
        with self.changed:
            if connected is not None:
                self.connected = connected and not self.stopped.is_set()
            self.revision += 1
            self.changed.notify_all()

    def close(self):
        self.stopped.set()
        self.signal(False)

    def ready(self):
        with self.changed:
            if not self.changed.wait_for(lambda: self.connected or self.stopped.is_set(), TIMELINE_OPEN_SECONDS):
                raise TimeoutError("Claudex events did not connect")
            if self.stopped.is_set():
                raise OSError("Claudex events are closed")
            return self.revision

    def wait(self, revision, timeout):
        with self.changed:
            self.changed.wait_for(lambda: self.revision != revision, timeout)
            return self.revision, self.connected

    def run(self):
        from websockets.exceptions import ConnectionClosed, WebSocketException

        delay = 1
        while not self.stopped.is_set():
            try:
                with self.probe.open_events() as connection:
                    self.follow(connection)
            except (OSError, ValueError, KeyError, WebSocketException) as error:
                if not self.stopped.is_set():
                    print("Claudex events disconnected", type(error).__name__, flush=True)
                if isinstance(error, ConnectionClosed) and error.rcvd and error.rcvd.code in (4003, 4008):
                    self.close()
            if self.connected:
                delay = 1
                self.signal(False)
            if self.stopped.wait(delay):
                return
            delay = min(30, delay * 2)

    def follow(self, connection):
        if self.stopped.is_set():
            return
        hello = {"t": "hello", "v": 1, "tabId": self.probe.tab}
        if self.last_seq is not None:
            hello["lastSeq"] = self.last_seq
        connection.send(json.dumps(hello))
        ready = json.loads(connection.recv(timeout=TIMELINE_OPEN_SECONDS))
        if ready["t"] != "ready":
            # The server sends the refusal before its close code.
            connection.recv(timeout=TIMELINE_OPEN_SECONDS)
            raise ValueError("Claudex events are unavailable")
        if not ready["resumed"] or self.last_seq is None:
            self.last_seq = ready["seq"]
        self.signal(True)
        ping_at = time.monotonic() + TIMELINE_HEARTBEAT_SECONDS
        last_message = time.monotonic()
        while not self.stopped.is_set():
            now = time.monotonic()
            if now >= ping_at:
                if now - last_message > 2 * TIMELINE_HEARTBEAT_SECONDS:
                    raise TimeoutError("Claudex events stopped responding")
                connection.send('{"t":"ping"}')
                ping_at = now + TIMELINE_HEARTBEAT_SECONDS
            try:
                frame = json.loads(connection.recv(timeout=min(ping_at - now, TIMELINE_CLOSE_CHECK_SECONDS)))
            except TimeoutError:
                continue
            last_message = time.monotonic()
            if frame["t"] == "snapshot" and frame["seq"] >= self.last_seq:
                self.last_seq = frame["seq"]
                self.signal()
            elif frame["t"] == "event" and frame["seq"] > self.last_seq:
                gap = frame["seq"] > self.last_seq + 1
                self.last_seq = frame["seq"]
                event = frame["event"]["type"]
                if event == "signed-out":
                    self.close()
                elif gap or event in TIMELINE_EVENTS:
                    self.signal()


class Probe:
    def __init__(self, credentials, backend):
        self.credentials = credentials
        self.backend = backend
        self.code = str(secrets.randbelow(900000) + 100000)
        self.session = secrets.token_urlsafe(32)
        self.tab = str(uuid4())
        self.org = str(uuid4())
        self.token = None
        self.lock = Lock()
        self.events = None
        self.requests = {}
        self.rows = {}
        self.code_sessions = {}
        now = timestamp()
        self.account = {
            "uuid": str(uuid4()), "email_address": "claudex-probe@example.test",
            "full_name": "Claudex QA", "display_name": "Claudex QA",
            "created_at": now, "updated_at": now, "is_verified": True,
            "onboarding_complete": True, "age_is_verified": True,
            "memberships": [{
                "organization": {
                    "uuid": self.org, "name": "Claudex QA",
                    "settings": {"claude_console_privacy": "private"},
                    "capabilities": ["chat"],
                },
                "role": "admin", "created_at": now,
                "updated_at": now, "notification_preferences": None,
            }],
        }

    def post(self, path, body):
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers.update({
                "Authorization": "Bearer " + self.token,
                "X-Claudex-Web-Tab": self.tab,
            })
        request = Request(self.backend + path, json.dumps(body).encode(), headers)
        with urlopen(request, timeout=25) as response:
            return json.load(response)

    def github(self, route="", **query):
        suffix = "?" + urlencode(query) if query else ""
        request = Request(self.backend + "/api/v1/claudex/web/github" + route + suffix, headers={
            "Authorization": "Bearer " + self.token, "X-Claudex-Web-Tab": self.tab,
        })
        with urlopen(request, timeout=25) as response:
            return json.load(response)["data"]

    def authenticate(self):
        if not self.token:
            self.token = self.post("/api/v1/auth/login", self.credentials)["data"]["access_token"]
            try:
                organization = self.organization()
            except (OSError, ValueError, KeyError, IndexError):
                self.token = None
                raise
            self.org = organization
            self.account["uuid"] = organization
            self.account["memberships"][0]["organization"]["uuid"] = organization

    def rpc(self, method, *args):
        response = self.post("/api/v1/claudex/web/rpc/" + method, {"args": args})
        if not response.get("ok"):
            raise ValueError("Claudex RPC rejected " + method)
        return response["value"]

    def open_events(self):
        from websockets.sync.client import connect

        ticket = self.post(EVENTS_ROOT + "/auth/events-ticket", {"tabId": self.tab})["data"]["ticket"]
        origin = urlsplit(self.backend)
        scheme = "wss" if origin.scheme == "https" else "ws"
        return connect(f"{scheme}://{origin.netloc}{EVENTS_ROOT}/events",
                       subprotocols=["claudex.v1", "ticket." + ticket],
                       open_timeout=TIMELINE_OPEN_SECONDS, close_timeout=1,
                       ping_interval=None, max_size=16 * 1024 * 1024)

    def timeline_events(self):
        with self.lock:
            if not self.token:
                raise OSError("Claudex session is closed")
            if self.events is None:
                self.events = TimelineEvents(self)
            return self.events

    def is_file_asset(self, path):
        return re.fullmatch(f"/api/(?:organizations/)?{self.org}/files/[A-Za-z0-9_-]{{1,500}}/"
                            r"(?:contents|content_preview|preview|thumbnail)", path) is not None

    def official_response(self, method, path, content_type=None, body=None, lease=None):
        request = {"method": method, "path": path}
        route = urlsplit(path).path
        if route == CODE_SESSIONS or CODE_SESSION_ROUTE.fullmatch(route) or CODE_QUEUED_ROUTE.fullmatch(route):
            request["codeOrganizationId"] = self.org
        if body is not None:
            request.update({"contentType": content_type, "body": self.upload_reference(body, content_type)})
        if lease is not None:
            request["capabilityLease"] = lease
        read = method == "GET" or path in (DEFAULTS_PATH, TIMELINE_PATH)
        file_asset = method == "GET" and self.is_file_asset(urlsplit(path).path)
        if file_asset:
            request["responseTransfer"] = True
        result = self.rpc("officialUiRead" if read else "officialUiAction", request)
        data = base64.b64decode(result["body"]["$bytes"])
        if file_asset and "responseTransfer" in result:
            transfer = result["responseTransfer"]
            identifier = uuid(transfer["id"])
            total_bytes = transfer["totalBytes"]
            if (not identifier or type(total_bytes) is not int
                    or not 2 * FILE_RESPONSE_CHUNK_BYTES < total_bytes <= FILE_RESPONSE_MAX_BYTES
                    or len(data) != FILE_RESPONSE_CHUNK_BYTES):
                raise ValueError("Invalid Claudex file transfer")
            chunks = [data]
            for offset in range(len(data), total_bytes, FILE_RESPONSE_CHUNK_BYTES):
                chunk = self.rpc("officialUiRead", {"method": "GET",
                    "path": f"/api/claudex/response_chunks/{identifier}?offset={offset}"})
                data = base64.b64decode(chunk["body"]["$bytes"])
                if (chunk["status"] != 200 or chunk.get("responseOffset") != offset
                        or len(data) != min(FILE_RESPONSE_CHUNK_BYTES, total_bytes - offset)):
                    raise ValueError("Incomplete Claudex file transfer")
                chunks.append(data)
            data = b"".join(chunks)
        return result["status"], result["contentType"], data

    def official(self, method, path, body=None, lease=None):
        status, _, data = self.official_response(method, path, "application/json",
                                                json.dumps(body).encode() if body is not None else None, lease)
        return status, json.loads(data)

    def upload_reference(self, body, content_type):
        if len(body) <= 256 * 1024:
            return {"$bytes": base64.b64encode(body).decode()}

        def request(path, method, content_type, payload):
            headers = {"Content-Type": content_type, "Authorization": "Bearer " + self.token,
                       "X-Claudex-Web-Tab": self.tab}
            with urlopen(Request(self.backend + path, payload, headers, method=method), timeout=25) as response:
                result = json.load(response)
            if not result.get("ok"):
                raise ValueError("Claudex upload stage was rejected")
            return result["value"]

        root = "/api/v1/claudex/web/uploads"
        upload = request(root, "POST", "application/json",
                         json.dumps({"name": "data", "type": content_type, "size": len(body)}).encode())
        identifier = upload["id"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier):
            raise ValueError("Invalid Claudex upload ID")
        chunk_size = 1024 * 1024
        for offset in range(0, len(body), chunk_size):
            request(f"{root}/{identifier}/chunks/{offset // chunk_size}", "PUT", "application/octet-stream",
                    body[offset:offset + chunk_size])
        request(f"{root}/{identifier}/complete", "POST", "application/json", b"{}")
        return {"$upload": identifier}

    def organization(self):
        return self.bootstrap()["account"]["memberships"][0]["organization"]["uuid"]

    def action_lease(self):
        status, capabilities = self.official("GET", "/api/claudex/official-capabilities/version1")
        if status != 200 or capabilities.get("mode") != "engine-chat":
            raise ValueError("Claudex Chat actions are unavailable")
        return capabilities["activationLease"]

    def forward_official(self, method, path, content_type=None, body=None):
        if method == "GET" and "/projects/" in path:
            route = urlsplit(path)
            if route.path.endswith("/detail"):
                path = route.path.removesuffix("/detail")
        return self.official_response(
            method, path, content_type, body,
            self.action_lease() if body is not None and path != DEFAULTS_PATH else None)

    def read_conversation(self, identifier):
        # Timeline has the same ConversationUpdate used by the unary APK response.
        query = proto_bytes(1, identifier.encode("ascii"))
        status, content_type, frames = self.official_response(
            "POST", TIMELINE_PATH, "application/connect+proto", connect_frame(query))
        if status != 200 or content_type != "application/connect+proto":
            raise ValueError("Claudex conversation timeline is unavailable")
        _, event = timeline_frame(frames)
        if 1 in event:
            return b"\x08\x01" + proto_bytes(2, event[1])
        if 3 in event and proto_values(event[3]).get(1) == b"not_found":
            return None
        raise ValueError("Claudex conversation timeline did not return a snapshot")

    def bootstrap(self):
        status, payload = self.official("GET", "/api/bootstrap")
        if status != 200:
            raise ValueError("Claudex bootstrap unavailable")
        return payload

    def selector(self, bootstrap=None):
        if bootstrap is None:
            bootstrap = self.bootstrap()
        config = next((row for row in bootstrap["model_selector_config"] if row["id"] == "chat"),
                      {"id": "chat", "models": []})
        state = next((row for row in bootstrap["model_selector_state"] if row["id"] == "chat"), None)
        models = []
        for model in config["models"]:
            efforts = [option for option in model.get("thinking", {}).get("effort_options", [])
                       if option["id"] in SEND_EFFORTS]
            entry = {key: model[key] for key in ("id", "name", "short_name", "description", "section") if key in model}
            if efforts:
                entry["thinking"] = {"effort_options": efforts}
            models.append(entry)
        return {**config, "models": models}, native_selector_state(state) if state else None

    def save_model(self, body):
        thinking = body.get("thinking")
        if isinstance(thinking, dict) and "effort" in thinking and (
            not isinstance(thinking["effort"], str) or thinking["effort"] not in SEND_EFFORTS
        ):
            return 400, {"error": {"type": "invalid_request", "message": "Unsupported effort"}}
        organization = self.organization()
        status, value = self.official("PATCH", f"/api/organizations/{organization}/model_selector_state/chat",
                                      body, self.action_lease())
        return status, native_selector_state(value) if status == 200 else value

    def send_model(self, body, previous):
        config, state = self.selector()
        model = body.get("model") or (previous or {}).get("model") or (state or {}).get("model")
        entry = next((entry for entry in config["models"] if entry["id"] == model), None)
        if not entry:
            raise ModelSelectionError("The selected model is unavailable")
        options = entry.get("thinking", {}).get("effort_options", [])
        allowed = {option["id"] for option in options}
        effort = body.get("effort")
        if effort is not None:
            if not isinstance(effort, str) or effort not in allowed:
                raise ModelSelectionError("The effort is unavailable for this model")
            return model, effort
        previous_effort = previous["settings"].get("effort_level") if previous and previous.get("model") == model else None
        saved_effort = next((row["thinking"].get("effort") for row in (state or {}).get("thinking_by_model", [])
                             if row["id"] == model), None)
        default_effort = next((option["id"] for option in options if option.get("recommended")),
                              options[0]["id"] if options else None)
        return model, next((value for value in (previous_effort, saved_effort, default_effort) if value in allowed), None)

    def conversation(self, previous, prompt, ids):
        messages = previous["chat_messages"] if previous else []
        human = uuid(ids.get("human_message_uuid"))
        assistant = uuid(ids.get("assistant_message_uuid"))
        if not human or not assistant:
            raise ValueError("Missing native turn message UUIDs")
        now = timestamp()
        turn = []
        for message_id, sender, message, parent in (
            (human, "human", prompt, messages[-1]["uuid"] if messages else None),
            (assistant, "assistant", "", human),
        ):
            turn.append({
                "uuid": message_id, "parent_message_uuid": parent, "sender": sender,
                "index": len(messages) + len(turn), "created_at": now, "updated_at": now,
                "text": message, "attachments": [],
                "content": [{"type": "text", "text": message}],
            })
        return turn

    def save(self, identifier, previous, prompt, turn, output, stop_reason, model, effort):
        with self.lock:
            row = previous or {
                "uuid": identifier, "name": prompt, "summary": "",
                "created_at": turn[0]["created_at"], "settings": {}, "chat_messages": [],
            }
            turn[-1]["stop_reason"] = stop_reason
            turn[-1]["text"] = output
            turn[-1]["content"][0]["text"] = output
            self.rows[identifier] = {
                **row, "updated_at": timestamp(), "model": model,
                "settings": {"effort_level": effort} if effort else {},
                "current_leaf_message_uuid": turn[-1]["uuid"],
                "chat_messages": row["chat_messages"] + turn,
            }


class Handler(BaseHTTPRequestHandler):
    @property
    def probe(self):
        return self.server.probe

    def log_message(self, *_):
        pass

    def reply(self, status, payload, *, login=False):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if login:
            self.send_header("Set-Cookie", "sessionKey=" + self.probe.session + "; Path=/; HttpOnly")
        self.end_headers()
        self.wfile.write(body)

    def reply_bytes(self, status, content_type, data):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def forward(self, method, body=None):
        try:
            url = urlsplit(self.path)
            path = self.path
            if url.path == "/v1/code/sessions":
                query = [(key, "failed" if key == "statuses" and value == "provision_failed" else value)
                         for key, value in parse_qsl(url.query)]
                path = url.path + ("?" + urlencode(query) if query else "")
            status, content_type, data = self.probe.forward_official(
                method, path, self.headers.get("Content-Type"), body)
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        if method == "POST" and url.path == f"/api/{self.probe.org}/upload":
            print(f"Claudex upload {status} multipart_bytes={len(body)}", flush=True)
        code = CODE_SESSION_ROUTE.fullmatch(url.path)
        if status == 200 and method == "GET" and (url.path == CODE_SESSIONS or code and code[2] is None):
            try:
                result = json.loads(data)
                if url.path == CODE_SESSIONS:
                    result["data"] = [android_code_session(session) for session in result["data"]]
                else:
                    result = {"response_shape": android_code_session(result["session"])}
                data = json.dumps(result).encode()
            except (ValueError, KeyError, TypeError):
                self.unavailable(502)
                return
        if status == 200 and method == "GET" and code and code[2] == "/events":
            try:
                page = json.loads(data)
                history = page["data"]
                with self.probe.lock:
                    state = self.code_state(code[1])
                    for event in history:
                        state.remember(event["sequence_num"], event["event_id"])
                query = parse_qs(url.query)
                descending = query.get("sort_order") == ["desc"]
                newest_page = not query.get("cursor") if descending else not page.get("next_cursor")
                if newest_page and "user" not in query.get("exclude_types", []):
                    pending = self.queued_code_events(code[1], page.get("queue", []), set())
                    if pending:
                        page["data"] = list(reversed(pending)) + history if descending else history + pending
                        data = json.dumps(page).encode()
            except (OSError, ValueError, KeyError, TypeError):
                self.unavailable(502)
                return
        self.reply_bytes(status, content_type, data)

    def unavailable(self, status=404):
        self.reply(status, {"error": {"type": "probe_error", "message": "Route or request unavailable in the local probe"}})

    def authenticated(self):
        cookie = SimpleCookie(self.headers.get("Cookie", "")).get("sessionKey")
        return bool(self.probe.token and cookie and secrets.compare_digest(cookie.value, self.probe.session))

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        print("GET", path, flush=True)
        if path == "/api/bootstrap":
            self.reply(200, {"account": self.probe.account if self.authenticated() else None})
            return
        if not self.authenticated():
            self.unavailable()
            return
        org = self.probe.org
        prefix = f"/api/organizations/{org}"
        github_branches = re.fullmatch(f"/api/github/organizations/{org}/github/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/branches", path)
        if path in (prefix + "/sync/github/auth", prefix + "/code/repos/all") or github_branches:
            try:
                params = parse_qs(url.query)
                if path.endswith("/sync/github/auth"):
                    status = self.probe.github()
                    answer = {"is_authenticated": bool(status["configured"] and status["connected"])}
                elif github_branches:
                    items = self.github_pages("/branches", repo=github_branches[1], query=params.get("query", [""])[0])
                    answer = {"data": items}
                else:
                    items = self.github_pages("/repos", query=params.get("q", [""])[0])
                    answer = {"repos": [{"repo": {"name": item["name"], "owner": {"login": item["owner"]},
                               "default_branch": item["default_branch"], "visibility": "private" if item["private"] else "public",
                               "sourceUrl": item["clone_url"]}, "source_url": item["clone_url"]} for item in items],
                              "is_complete": True}
            except (OSError, ValueError, KeyError):
                self.unavailable(502)
                return
            self.reply(200, answer)
            return
        code = CODE_SESSION_ROUTE.fullmatch(path)
        if path == f"/api/bootstrap/{org}/app_start":
            try:
                bootstrap = self.probe.bootstrap()
                configuration, state = self.probe.selector(bootstrap)
                cloud_code = self.probe.rpc("snapshot")["host"]["capabilities"]["cloudCode"]
            except (OSError, ValueError, KeyError):
                self.unavailable(502)
                return
            organization = self.probe.account["memberships"][0]["organization"]
            account = {**self.probe.account, "memberships": [{
                **self.probe.account["memberships"][0],
                "organization": {**organization, "claude_ai_bootstrap_models_config": [
                    {"model": model["id"], "name": model["name"], "overflow": model.get("section") == "overflow"}
                    for model in configuration["models"]
                ]},
            }]}
            self.reply(200, {"account": account, "model_selector_config": [configuration],
                             "current_user_access": bootstrap.get("current_user_access"),
                             "model_selector_state": [state] if state else [],
                             "org_growthbook": {
                                 "hashing_algorithm": "djb2",
                                 "features": {
                                     "claudeai_new_window": {"defaultValue": True},
                                     "mobile_android_remote_enabled": {"defaultValue": cloud_code},
                                     "code_steering_messages": {"defaultValue": cloud_code},
                                     "ccr_transcript_turn_merge": {"defaultValue": cloud_code},
                                     "ccr_queued_send_post_at_later": {"defaultValue": cloud_code},
                                     "android_new_chat_drafts_per_chat": {"defaultValue": True},
                                     "claude_ai_projects_limits": {"defaultValue": {"max_free_projects": 1}},
                                 },
                             }})
        elif path == "/api/account":
            self.reply(200, self.probe.account)
        elif code and code[2] == "/events/stream":
            self.code_stream(url, code[1])
        elif re.fullmatch(re.escape(prefix) + r"/projects(?:_v2)?(?:/[a-f0-9-]{36}(?:/(?:detail|docs|files|conversations(?:_v2)?))?)?", path):
            self.forward("GET")
        elif (
            path in (f"/api/bootstrap/{org}/current_user_access", "/v1/code/sessions",
                     f"/v1/environment_providers/private/organizations/{org}/environments",
                     prefix + "/mcp/v2/bootstrap", prefix + "/memory/settings")
            or re.fullmatch(r"/v1/code/sessions/(?:session|cse)_[A-Za-z0-9_-]+(?:/events)?", path)
            or self.probe.is_file_asset(path)
        ):
            self.forward("GET")
        elif path == prefix + "/experiences":
            self.reply(200, {"experiences": []})
        elif path == prefix + "/recents":
            section = parse_qs(url.query).get("section", ["recents"])[0]
            rows = []
            if section == "recents":
                try:
                    status, page = self.probe.official("GET", prefix + "/chat_conversations_v2?limit=50")
                    if status != 200:
                        raise ValueError("Claudex chat history is unavailable")
                except (OSError, ValueError, KeyError):
                    self.unavailable(502)
                    return
                with self.probe.lock:
                    local = {key: {k: v for k, v in row.items() if k != "chat_messages"}
                             for key, row in self.probe.rows.items()}
                indexed = {row["uuid"]: row for row in page["data"]}
                for key, row in local.items():
                    indexed[key] = indexed.get(key, {}) | row
                rows = [row | {"type": "chat"} for row in
                        sorted(indexed.values(), key=lambda row: row["updated_at"], reverse=True)]
            self.reply(200, {"sections": [{"id": section, "title": "Recents", "data": rows}]})
        elif re.fullmatch(re.escape(prefix) + r"/chat_conversations/[a-f0-9-]{36}", path):
            identifier = path.removeprefix(prefix + "/chat_conversations/")
            with self.probe.lock:
                row = self.probe.rows.get(identifier)
            if row:
                self.reply(200, row)
            else:
                self.forward("GET")
        else:
            self.unavailable()

    def github_pages(self, route, **query):
        items = []
        page = 1
        while page is not None:
            result = self.probe.github(route, page=page, **query)
            items.extend(result["items"])
            next_page = result["next_page"]
            if next_page is not None and (not isinstance(next_page, int) or next_page <= page):
                raise ValueError("Invalid GitHub page")
            page = next_page
        return items

    def request_bytes(self, limit=65536):
        size = int(self.headers.get("Content-Length", 0))
        if not 0 <= size <= limit:
            raise OverflowError
        data = self.rfile.read(size)
        if self.headers.get("Content-Encoding") == "gzip" or data.startswith(b"\x1f\x8b"):
            data = gzip.GzipFile(fileobj=io.BytesIO(data)).read(limit + 1)
        if len(data) > limit:
            raise OverflowError
        return data

    def request_body(self, limit=65536):
        data = self.request_bytes(limit)
        body = json.loads(data) if data else {}
        if not isinstance(body, dict):
            raise ValueError("Expected a JSON object")
        return body

    def do_PATCH(self):
        path = urlsplit(self.path).path
        print("PATCH", path, flush=True)
        if path != f"/api/organizations/{self.probe.org}/model_selector_state/chat" or not self.authenticated():
            self.unavailable()
            return
        try:
            body = self.request_body()
        except OverflowError:
            self.unavailable(413)
            return
        except (OSError, ValueError):
            self.unavailable(400)
            return
        try:
            status, value = self.probe.save_model(body)
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        self.reply(status, value)

    def do_PUT(self):
        probe = self.probe
        path = urlsplit(self.path).path
        print("PUT", path, flush=True)
        match = re.fullmatch(f"/api/organizations/{probe.org}/chat_conversations/([a-f0-9-]{{36}})", path)
        if not match or not self.authenticated():
            self.unavailable()
            return
        identifier = match[1]
        with probe.lock:
            previous = probe.rows.get(identifier)
        if previous is None:
            self.unavailable()
            return
        try:
            settings = self.request_body()["settings"]
            effort = settings["effort_level"]
            if set(settings) != {"effort_level"} or not isinstance(effort, str):
                raise ValueError("Expected a conversation effort")
            _, effort = probe.send_model({"model": previous["model"], "effort": effort}, previous)
            updated = probe.rpc("updateConversation", identifier, {"effort": effort})
            if updated.get("effort") != effort:
                raise ValueError("Claudex did not save the conversation effort")
        except OverflowError:
            self.unavailable(413)
            return
        except (ValueError, KeyError, TypeError):
            self.unavailable(400)
            return
        except OSError:
            self.unavailable(502)
            return
        with probe.lock:
            probe.rows[identifier] = {**probe.rows[identifier], "settings": {"effort_level": effort}}
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        path = urlsplit(self.path).path
        if self.path == TIMELINE_PATH and self.authenticated():
            self.timeline()
            return
        if self.path in (DEFAULTS_PATH, READ_CONVERSATION_PATH, ACTION_PATH):
            if not self.authenticated():
                self.unavailable()
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/proto":
                self.unavailable(400)
                return
            print("POST", path, flush=True)
            try:
                body = self.request_bytes(ACTION_MAX_BYTES if path == ACTION_PATH else 65536)
                if path == ACTION_PATH:
                    refused = attachment_refusal(body)
                    if refused is not None:
                        self.reply_bytes(200, "application/proto", refused)
                        return
                    body = runner_action(body)
            except OverflowError:
                self.unavailable(413)
                return
            except (OSError, EOFError, KeyError, TypeError, ValueError):
                self.unavailable(400)
                return
            if path == READ_CONVERSATION_PATH:
                self.read_conversation(body)
            else:
                self.forward("POST", body)
            return
        if path == f"/api/{self.probe.org}/upload" and self.authenticated():
            content_type = self.headers.get("Content-Type", "")
            if not content_type.startswith("multipart/form-data;"):
                self.unavailable(400)
                return
            try:
                body = self.request_bytes(CHAT_UPLOAD_MAX_BYTES)
                oversized = oversized_image_upload(body, content_type)
            except OverflowError:
                self.unavailable(413)
                return
            except (OSError, EOFError, ValueError):
                self.unavailable(400)
                return
            if not body:
                self.unavailable(413)
                return
            if oversized:
                self.reply(413, {"error": {"type": "invalid_request_error",
                                          "message": "The attachment exceeds its file-type size limit."}})
                return
            self.forward("POST", body)
            return
        if path == "/api/auth/logout" and self.authenticated():
            with self.probe.lock:
                if self.probe.events:
                    self.probe.events.close()
                    self.probe.events = None
                self.probe.token = None
                self.probe.session = secrets.token_urlsafe(32)
                self.probe.code_sessions.clear()
            self.send_response(204)
            self.send_header("Set-Cookie", "sessionKey=; Path=/; HttpOnly; Max-Age=0")
            self.end_headers()
            return
        code = CODE_SESSION_ROUTE.fullmatch(path)
        code_event = code and code[2] == "/events"
        code_write = path == CODE_SESSIONS or code_event
        if code_write and not self.authenticated():
            self.unavailable()
            return
        try:
            body = self.request_body(CODE_INPUT_MAX_BYTES) if code_event else self.request_body()
        except OverflowError:
            self.unavailable(413)
            return
        except (OSError, ValueError):
            self.unavailable(400)
            return
        print("POST", path, flush=True)
        if path == CODE_SESSIONS:
            self.code_create(body)
            return
        if code and code[2] == "/events":
            self.code_action(code[1], body)
            return
        if path == "/api/auth/send_magic_link" and body.get("email_address") == self.probe.account["email_address"]:
            self.reply(200, {"sent": True, "fallback_code_configuration": {
                "charset": "numeric", "length": 6, "show_input_after_delay": 0,
            }})
        elif path == "/api/auth/verify_magic_link":
            self.verify(body.get("credentials", {}))
        else:
            match = re.fullmatch(
                f"/api/organizations/{self.probe.org}/chat_conversations/([a-f0-9-]{{36}})/(completion|stop_response)",
                path,
            )
            if not match or not self.authenticated():
                self.unavailable()
                return
            if match[2] == "stop_response":
                self.stop(match[1], body)
            else:
                self.complete(match[1], body)

    def code_create(self, body):
        try:
            config = body["config"]
            if not isinstance(config, dict):
                raise ValueError("Invalid Code configuration")
            config.setdefault("outcomes", [])
            body.setdefault("events", [])
        except (ValueError, KeyError, TypeError):
            self.unavailable(400)
            return
        try:
            status, content_type, data = self.probe.forward_official(
                "POST", CODE_SESSIONS, "application/json", json.dumps(body).encode())
            if status == 200:
                result = json.loads(data)
                result["session"] = android_code_session(result["session"])
                data = json.dumps(result).encode()
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        print("Claudex Code create", status, flush=True)
        self.reply_bytes(status, content_type, data)

    def code_action(self, session, body):
        path = f"{CODE_SESSIONS}/{session}"
        try:
            events = normalize_code_events(body.get("events"))
            if body.get("session_id") != session or not events:
                raise ValueError("Invalid Code session")
        except (ValueError, TypeError):
            self.unavailable(400)
            return
        payload = events[0]["payload"]
        control = payload.get("request") or {}
        if not isinstance(control, dict):
            self.unavailable(400)
            return
        subtype = control.get("subtype") if payload.get("type") == "control_request" else None
        if subtype == "initialize":
            control.pop("promptSuggestions", None)
        stop_id = payload.get("request_id") if subtype == "interrupt" else None
        if subtype == "interrupt" and not isinstance(stop_id, str):
            self.unavailable(400)
            return
        receipt = None
        first = True
        try:
            if stop_id is not None:
                with self.probe.lock:
                    state = self.code_state(session)
                    stop = state.stops.get(stop_id)
                    first = stop is None
                    if stop is None and (state.stop_target or control.get("queued_message_uuid") or control.get("cancel_queued")):
                        stop = (state.stop_target, Future())
                        state.stops[stop_id] = stop
                if stop is None:
                    self.unavailable(409)
                    return
                if stop[0]:
                    control["turn_target"] = stop[0]
                receipt = stop[1]
            if first:
                result = self.probe.forward_official("POST", path + "/events", "application/json", json.dumps(body).encode())
                if receipt:
                    receipt.set_result(result)
            else:
                result = receipt.result(timeout=30)
            status, content_type, data = result
        except (OSError, ValueError, KeyError, FutureTimeout):
            if receipt and first:
                receipt.set_result((502, "application/json", b'{"error":"Claudex Code Stop was not confirmed"}'))
            self.unavailable(502)
            return
        print("Claudex Code action", payload.get("type"), subtype or "", status, flush=True)
        if content_type == "application/vnd.claudex.code-control+json":
            reply = json.loads(data)
            response = {"request_id": reply["requestId"]}
            if "error" in reply:
                response.update(subtype="error", error=reply["error"])
            else:
                response.update(subtype="success", response=reply["response"])
            with self.probe.lock:
                self.code_state(session).controls.append(sse_frame("client_event", {
                    "source": "worker", "event_type": "control_response", "payload": {
                        "type": "control_response", "uuid": str(uuid4()), "response": response,
                    },
                }, 0))
            self.probe.timeline_events().signal()
            self.reply(status, {})
        else:
            self.reply_bytes(status, content_type, data)

    def code_state(self, session):
        return self.probe.code_sessions.setdefault(session.split("_", 1)[1], CodeSession())

    def queued_code_events(self, session, queue, seen):
        pending = []
        root = f"{CODE_SESSIONS}/{session}/events/queue"
        for entry in queue:
            event_id = entry.get("event_id")
            if not event_id or event_id in seen:
                continue
            identifier = uuid(entry["uuid"])
            if not identifier:
                raise ValueError("Invalid queued Code input ID")
            status, payload = self.probe.official("GET", f"{root}/{identifier}")
            if status == 404:
                continue
            if status != 200 or payload.get("type") != "user" or payload.get("uuid") != identifier:
                raise ValueError("Claudex queued Code input is unavailable")
            pending.append({"event_id": event_id, "event_type": "user", "sequence_num": 0,
                            "source": "client", "created_at": payload["timestamp"], "payload": payload})
        return pending

    def code_stream(self, url, session):
        cursor = parse_qs(url.query).get("from_sequence_num", ["0"])[0]
        if not re.fullmatch(r"0|[1-9][0-9]{0,15}", cursor):
            self.unavailable(400)
            return
        with self.probe.lock:
            state = self.code_state(session)
            anchor = state.anchors.get(int(cursor))
        stream = CodeStream("session_" + session.split("_", 1)[1], int(cursor), anchor)
        try:
            events = self.probe.timeline_events()
            revision = events.ready()
            status, batch = self.probe.official("GET", stream.query(url.path))
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        if status not in (200, 410) or status == 410 and stream.sequence == 0:
            self.reply(status, batch)
            return
        self.protocol_version = "HTTP/1.1"
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        print("Claudex Code stream open", session, "from", stream.sequence, flush=True)
        try:
            self.timeline_chunk(sse_frame("session_update", {"connection_status": "connected"}))
            heartbeat_at = time.monotonic() + CODE_HEARTBEAT_SECONDS
            while not events.stopped.is_set():
                if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                    return
                if status == 410:
                    status, history = self.probe.official("GET", f"{CODE_SESSIONS}/{session}/events?sort_order=desc&limit=1")
                    if status != 200 or not history["data"]:
                        return
                    latest = history["data"][0]
                    self.timeline_chunk(sse_frame("catch_up_truncated", {"from_sequence_num": stream.sequence,
                                        "at_sequence_num": latest["sequence_num"]}))
                    stream.sequence, stream.anchor = latest["sequence_num"], latest["event_id"]
                    stream.preview = None
                    status, batch = self.probe.official("GET", stream.query(url.path))
                if status != 200 or batch["session"]["id"] != stream.session:
                    return
                with self.probe.lock:
                    target = batch["session"].get("claudex_stop_target")
                    state.stop_target = target["target"] if target else None
                    controls, state.controls = state.controls, []
                for frame in controls:
                    self.timeline_chunk(frame)
                pending = [] if batch["has_more"] else self.queued_code_events(session, batch.get("queue", []), stream.queued)
                for frame in stream.frames(batch, pending):
                    if stream.anchor:
                        with self.probe.lock:
                            state.remember(stream.sequence, stream.anchor)
                    self.timeline_chunk(frame)
                if not batch["has_more"]:
                    while not events.stopped.is_set():
                        if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                            return
                        if time.monotonic() >= heartbeat_at:
                            self.timeline_chunk(b": heartbeat\n\n")
                            heartbeat_at = time.monotonic() + CODE_HEARTBEAT_SECONDS
                        next_revision, connected = events.wait(revision, TIMELINE_CLOSE_CHECK_SECONDS)
                        if not connected:
                            return
                        if next_revision != revision:
                            revision = next_revision
                            break
                status, batch = self.probe.official("GET", stream.query(url.path))
        except (OSError, ValueError, KeyError):
            return

    def read_conversation(self, body):
        try:
            wire_identifier = proto_values(body).get(1)
            identifier = uuid(wire_identifier.decode("ascii")) if isinstance(wire_identifier, bytes) else None
            if not identifier:
                raise ValueError("Invalid conversation UUID")
        except ValueError:
            self.reply(400, {"code": "invalid_argument", "message": "Invalid conversation UUID"})
            return
        try:
            response = self.probe.read_conversation(identifier)
        except (OSError, TypeError, ValueError, KeyError):
            self.reply(502, {"code": "unavailable", "message": "Claudex conversation is unavailable"})
            return
        if response is None:
            self.reply(404, {"code": "not_found", "message": "Conversation not found"})
            return
        self.reply_bytes(200, "application/proto", response)

    def timeline(self):
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0]
        try:
            if content_type != "application/connect+proto":
                self.unavailable(400)
                return
            if self.headers.get("Transfer-Encoding") == "chunked":
                chunks = bytearray()
                while True:
                    size = int(self.rfile.readline(32).strip(), 16)
                    if not 0 <= size <= 65536 - len(chunks):
                        raise ValueError("Timeline request exceeds the limit")
                    if size == 0:
                        if self.rfile.readline(32) != b"\r\n":
                            raise ValueError("Invalid timeline chunk termination")
                        break
                    chunks.extend(self.rfile.read(size))
                    if self.rfile.read(2) != b"\r\n":
                        raise ValueError("Invalid timeline chunk")
                body = bytes(chunks)
            else:
                size = int(self.headers.get("Content-Length", "0"))
                if not 5 <= size <= 65536:
                    self.unavailable(400)
                    return
                body = self.rfile.read(size)
            if len(body) < 5 or body[0] not in (0, 1) or int.from_bytes(body[1:5], "big") != len(body) - 5:
                self.unavailable(400)
                return
            if body[0] == 1:
                with gzip.GzipFile(fileobj=io.BytesIO(body[5:])) as compressed:
                    payload = compressed.read(65532)
                if len(payload) > 65531:
                    self.unavailable(413)
                    return
                body = connect_frame(payload)
            query = proto_values(body[5:])
            if uuid(query[1].decode("ascii")) is None:
                raise ValueError("Invalid conversation UUID")
        except (OSError, ValueError, EOFError, KeyError, AttributeError):
            self.unavailable(400)
            return
        try:
            events = self.probe.timeline_events()
            revision = events.ready()
            status, response_type, frames = self.probe.official_response("POST", TIMELINE_PATH, content_type, body)
            if status == 200:
                if response_type != "application/connect+proto":
                    raise ValueError("Invalid Claudex response type")
                timeline_frame(frames)
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        if status != 200:
            self.reply_bytes(status, response_type, frames)
            return
        self.protocol_version = "HTTP/1.1"
        self.close_connection = True
        print("Claudex timeline open", query[1].decode("ascii"), flush=True)
        try:
            self.send_response(200)
            self.send_header("Content-Type", response_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Connection", "close")
            self.end_headers()
            self.stream_timeline(events, revision, body, frames, bool(query.get(6)))
        except (OSError, ValueError, KeyError):
            return

    def timeline_chunk(self, frame):
        self.wfile.write(f"{len(frame):x}\r\n".encode() + frame + b"\r\n")
        self.wfile.flush()

    def stream_timeline(self, events, revision, request, frame, existing_only):
        previous = None
        frames_sent = 0
        heartbeat_at = time.monotonic() + TIMELINE_HEARTBEAT_SECONDS
        wait_for_create_until = time.monotonic() + TIMELINE_CREATE_SECONDS
        reconnect_until = None
        while not events.stopped.is_set():
            if select.select([self.connection], [], [], 0)[0] and not self.connection.recv(1, socket.MSG_PEEK):
                return
            now = time.monotonic()
            frame, event = timeline_frame(frame)
            pending_create = (3 in event and proto_values(event[3]).get(1) == b"not_found"
                              and previous is None and not existing_only and now < wait_for_create_until)
            if not pending_create:
                if 1 not in event:
                    self.timeline_chunk(frame)
                    self.timeline_chunk(connect_frame(b"{}", flags=2))
                    self.wfile.write(b"0\r\n\r\n")
                    return
                if event[1] != previous:
                    self.timeline_chunk(frame)
                    previous = event[1]
                    frames_sent += 1
                    heartbeat_at = now + TIMELINE_HEARTBEAT_SECONDS
            if now >= heartbeat_at:
                heartbeat = proto_bytes(6, proto_integer(1, frames_sent))
                self.timeline_chunk(connect_frame(proto_bytes(1, heartbeat)))
                heartbeat_at = now + TIMELINE_HEARTBEAT_SECONDS
            wake_at = min(heartbeat_at, wait_for_create_until) if pending_create else heartbeat_at
            next_revision, connected = events.wait(revision, min(max(0, wake_at - time.monotonic()),
                                                                 TIMELINE_CLOSE_CHECK_SECONDS))
            if not connected:
                if reconnect_until is None:
                    reconnect_until = time.monotonic() + TIMELINE_OPEN_SECONDS
                if time.monotonic() >= reconnect_until:
                    return
                revision = next_revision
                continue
            reconnect_until = None
            if next_revision != revision:
                revision = next_revision
                status, response_type, frame = self.probe.official_response(
                    "POST", TIMELINE_PATH, "application/connect+proto", request)
                if status != 200 or response_type != "application/connect+proto":
                    raise ValueError("Claudex conversation timeline could not be refreshed")

    def verify(self, proof):
        if proof.get("email_address") != self.probe.account["email_address"] or not secrets.compare_digest(
            str(proof.get("code", "")), self.probe.code
        ):
            self.reply(200, {"success": False})
            return
        try:
            self.probe.authenticate()
        except (OSError, ValueError, KeyError):
            self.unavailable(502)
            return
        print("Claudex acceptance account authenticated", flush=True)
        self.reply(200, {
            "success": True, "account": self.probe.account,
            "secret": self.probe.session, "created": False,
        }, login=True)

    def stop(self, identifier, body):
        probe = self.probe
        with probe.lock:
            if body == {}:
                operation = next((op for op in probe.requests.values()
                                  if op.conversation_id == identifier and not op.finished), None)
            else:
                operation = probe.requests.get(uuid(body.get("completion_request_id")))
            if not operation or operation.conversation_id != identifier:
                self.unavailable(409)
                return
            operation.stop_requested = True
        try:
            target = operation.target.result(timeout=25)
            result = probe.rpc("interrupt", identifier, target)
            if result["status"] not in ("accepted", "already_finished"):
                self.unavailable(409)
                return
        except (OSError, ValueError, KeyError, TypeError, FutureTimeout):
            self.unavailable(502)
            return
        print("Claudex stop", identifier, result["status"], flush=True)
        self.send_response(204)
        self.end_headers()

    def complete(self, identifier, body):
        probe = self.probe
        prompt = body.get("prompt")
        request_id = uuid(body.get("completion_request_id"))
        if not isinstance(prompt, str) or not prompt.strip() or body.get("attachments") or body.get("files"):
            self.unavailable(422)
            return
        parent = body.get("parent_message_uuid")
        with probe.lock:
            previous = probe.rows.get(identifier)
        if previous is None and parent not in (None, "00000000-0000-0000-0000-000000000000"):
            try:
                status, previous = probe.official("GET", f"/api/organizations/{probe.org}/chat_conversations/{identifier}")
            except (OSError, ValueError, KeyError):
                self.unavailable(502)
                return
            if status != 200:
                self.unavailable(status)
                return
        try:
            messages = probe.conversation(previous, prompt, body.get("turn_message_uuids") or {})
        except ValueError:
            self.unavailable(422)
            return
        new = previous is None
        with probe.lock:
            current = probe.rows.get(identifier, previous)
            if (
                not request_id or request_id in probe.requests or len(probe.requests) >= 2
                or any(op.conversation_id == identifier and not op.finished for op in probe.requests.values())
                or (current is not None and parent != current["current_leaf_message_uuid"])
            ):
                self.unavailable(409)
                return
            operation = Completion(identifier)
            probe.requests[request_id] = operation
        try:
            model, effort = probe.send_model(body, previous)
            settings = probe.rpc("snapshot")["settings"]
            providers = settings["providers"]
            provider = next((provider for provider in providers
                             if provider["id"] == settings["activeProviderId"] and (
                                 model == provider.get("model") or model in provider.get("models", [])
                                 or any(model in route["models"] for route in provider.get("routes", []))
                             )), None)
            if not provider:
                raise ValueError("No provider for the selected model")
            sent = probe.rpc("send", {
                "newConversationId" if new else "conversationId": identifier,
                "mode": "chat", "text": prompt, "model": model,
                "providerId": provider["id"], "attachments": [],
                **({"effort": effort} if effort else {}),
            })
            turn = sent["turns"][-1]
            if sent["id"] != identifier or turn["id"].startswith("pending-") or turn["prompt"] != prompt:
                raise ValueError("The dispatched turn could not be identified")
            target = {
                "turnId": turn["id"], "turnCreatedAt": turn["createdAt"],
                "conversationCreatedAt": sent["createdAt"],
            }
            if sent.get("threadId") is not None:
                target["threadId"] = sent["threadId"]
            operation.target.set_result(target)
        except (OSError, ValueError, KeyError, IndexError) as error:
            operation.target.set_exception(error)
            with probe.lock:
                operation.finished = True
            if isinstance(error, ModelSelectionError):
                self.reply(400, {"error": {"type": "invalid_request_error", "message": str(error)}})
            else:
                self.unavailable(502)
            return
        print("Claudex send accepted", identifier, target["turnId"], model, effort or "default", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.sse_open = True
        try:
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            self.sse_open = False
        self.emit("message_start", message={"uuid": messages[1]["uuid"], "parent_uuid": messages[0]["uuid"]})
        try:
            output, stop_reason = self.stream(operation, target["turnId"])
            if stop_reason is None:
                self.emit("error", error={"type": "completion_error", "message": "Claudex completion did not finish"})
                return
            probe.save(identifier, previous, prompt, messages, output, stop_reason, model, effort)
            if output:
                self.emit("content_block_stop", index=0, stop_timestamp=timestamp())
            self.emit("message_delta", delta={"stop_reason": stop_reason, "stop_sequence": None})
            self.emit("message_stop")
            print("Claudex turn saved", identifier, target["turnId"], stop_reason, len(output), "characters", flush=True)
        finally:
            with probe.lock:
                operation.finished = True

    def emit(self, event, **fields):
        if not self.sse_open:
            return
        data = json.dumps({"type": event, **fields})
        try:
            self.wfile.write(f"event: {event}\ndata: {data}\n\n".encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.sse_open = False

    def stream(self, operation, turn_id):
        identifier = operation.conversation_id
        output = ""
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                turns = self.probe.rpc("conversationTurns", identifier)["turns"]
                turn = next((turn for turn in turns if turn["id"] == turn_id), None)
            except (OSError, ValueError, KeyError):
                break
            if turn:
                next_output = "".join(item.get("text", "") for item in turn["items"] if item["type"] == "agentMessage")
                if not next_output.startswith(output):
                    break
                if next_output != output:
                    if not output:
                        self.emit("content_block_start", index=0, content_block={"type": "text", "text": ""})
                    self.emit("content_block_delta", index=0, delta={"type": "text_delta", "text": next_output[len(output):]})
                    output = next_output
                if turn["status"] == "completed":
                    return output, "end_turn" if output else None
                if turn["status"] == "interrupted":
                    if turn.get("userStopped"):
                        return output, "user_canceled"
                    with self.probe.lock:
                        if not operation.stop_requested:
                            break
                if turn["status"] == "failed":
                    break
            time.sleep(1)
        return output, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("acceptance_account", type=Path, help="JSON with email and password for a dedicated test account")
    parser.add_argument("--port", type=int, default=48961)
    parser.add_argument("--backend", default="https://claudex.zecous.cn")
    args = parser.parse_args()
    try:
        from websockets.sync.client import connect
    except ImportError:
        parser.error('Install the Android timeline dependency with python3 -m pip install "websockets>=15,<16"')
    account = json.loads(args.acceptance_account.read_text())
    probe = Probe({key: account[key] for key in ("email", "password")}, args.backend.rstrip("/"))
    with ThreadingHTTPServer(("127.0.0.1", args.port), Handler) as server:
        server.probe = probe
        print("Local email", probe.account["email_address"], flush=True)
        print("Local code", probe.code, flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
