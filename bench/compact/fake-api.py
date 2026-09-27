#!/usr/bin/env python3
"""A local stand-in for the Messages API, so the installed host can be driven through compactions at no cost.

The main loop (a request carrying the Read tool) is answered with one Read per turn over note00..noteNN in CWD, then a
closing text. Usage is reported from the request's own size, inflated (chars / DIV) so the host's auto compaction comes
after a few files. Every request body is written to OUT/req-NNN.json (never headers). Anything else gets a minimal reply.
No model runs and nothing is billed; it checks what the host SENDS (message structure after a compaction), not how a
model would answer it.

Usage: fake-api.py PORT CWD OUT [FILES=8] [DIV=1.2]   (CWD holds note00.txt.. of about 20 KB each)
  cd CWD && ANTHROPIC_BASE_URL=http://127.0.0.1:PORT ANTHROPIC_API_KEY=sk-ant-fake-local \
    CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
    claude -p --model sonnet --plugin-dir <repo>/mods/compact --settings <options json> "Read the notes one per turn." </dev/null
"""
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, CWD, OUT = int(sys.argv[1]), sys.argv[2], sys.argv[3]
FILES = int(sys.argv[4]) if len(sys.argv) > 4 else 8
DIV = float(sys.argv[5]) if len(sys.argv) > 5 else 1.2
os.makedirs(OUT, exist_ok=True)
lock = threading.Lock()
state = {'n': 0, 'reads': 0}


def sse(events):
    return ''.join(f'event: {e["type"]}\ndata: {json.dumps(e)}\n\n' for e in events).encode()


def message(blocks, stop, tokens):
    usage = {'input_tokens': tokens, 'output_tokens': 20, 'cache_read_input_tokens': 0, 'cache_creation_input_tokens': 0}
    return {'id': f'msg_fake{state["n"]}', 'type': 'message', 'role': 'assistant', 'model': 'claude-sonnet-5',
            'content': blocks, 'stop_reason': stop, 'stop_sequence': None, 'usage': usage}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(404, b'{"type":"error","error":{"type":"not_found_error","message":"fake"}}')

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('content-length') or 0))
        path = self.path.split('?')[0]
        try:
            body = json.loads(raw or b'{}')
        except ValueError:
            body = {}
        with lock:
            state['n'] += 1
            n = state['n']
            with open(f'{OUT}/req-{n:03d}.json', 'w') as f:
                json.dump({'path': self.path, 'body': body}, f)
        tokens = int(len(json.dumps(body.get('messages', []))) / DIV)
        if path.endswith('/count_tokens'):
            return self.reply(200, json.dumps({'input_tokens': tokens}).encode())
        if not path.endswith('/v1/messages'):
            return self.reply(404, b'{"type":"error","error":{"type":"not_found_error","message":"fake"}}')
        main = any(t.get('name') == 'Read' for t in body.get('tools') or [])
        if main and state['reads'] < FILES:
            with lock:
                k = state['reads']
                state['reads'] += 1
            blocks = [{'type': 'text', 'text': f'Reading note{k:02d}.txt.'},
                      {'type': 'tool_use', 'id': f'toolu_fake{k:02d}', 'name': 'Read', 'input': {'file_path': f'{CWD}/note{k:02d}.txt'}}]
            stop = 'tool_use'
        else:
            blocks = [{'type': 'text', 'text': 'Done.' if main else 'ok'}]
            stop = 'end_turn'
        msg = message(blocks, stop, tokens)
        if not body.get('stream'):
            return self.reply(200, json.dumps(msg).encode())
        events = [{'type': 'message_start', 'message': {**msg, 'content': [], 'stop_reason': None}}]
        for i, b in enumerate(blocks):
            if b['type'] == 'text':
                events += [{'type': 'content_block_start', 'index': i, 'content_block': {'type': 'text', 'text': ''}},
                           {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'text_delta', 'text': b['text']}}]
            else:
                events += [{'type': 'content_block_start', 'index': i, 'content_block': {**b, 'input': {}}},
                           {'type': 'content_block_delta', 'index': i, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(b['input'])}}]
            events.append({'type': 'content_block_stop', 'index': i})
        events += [{'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 20}},
                   {'type': 'message_stop'}]
        self.reply(200, sse(events), 'text/event-stream')


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
