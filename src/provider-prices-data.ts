// Generated from official provider metadata by scripts/model-sync.mjs.
export default [
  {
    "host": "claude",
    "model": "claude-fable-5-1",
    "source": "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    "revision": "a498a608cb5954d4",
    "bands": [
      {
        "maxPrompt": 1000000,
        "input": 10,
        "write5m": 12.5,
        "write1h": 20,
        "read": 0.25,
        "output": 50
      }
    ]
  },
  {
    "host": "claude",
    "model": "claude-opus-5-5",
    "source": "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    "revision": "2d4a695aa0e17cf6",
    "bands": [
      {
        "maxPrompt": 1000000,
        "input": 4,
        "write5m": 5,
        "write1h": 8,
        "read": 0.2,
        "output": 20
      }
    ]
  },
  {
    "host": "claude",
    "model": "claude-sonnet-5-5",
    "source": "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    "revision": "fd614ff95ee6d6e9",
    "bands": [
      {
        "maxPrompt": 1000000,
        "input": 2,
        "write5m": 2.5,
        "write1h": 4,
        "read": 0.1,
        "output": 10
      }
    ]
  },
  {
    "host": "claude",
    "model": "claude-haiku-5-5",
    "source": "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
    "revision": "2945b7d02e647270",
    "bands": [
      {
        "maxPrompt": 100000,
        "input": 0.1,
        "write5m": 0.125,
        "write1h": 0.2,
        "read": 0.01,
        "output": 0.5
      },
      {
        "maxPrompt": 1000000,
        "input": 0.5,
        "write5m": 0.625,
        "write1h": 1,
        "read": 0.05,
        "output": 2.5
      }
    ]
  },
  {
    "host": "codex",
    "model": "gpt-6.1-sol",
    "source": "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    "revision": "68b84362cd24232a",
    "bands": [
      {
        "input": 2,
        "read": 0.1,
        "write": 2.5,
        "output": 10,
        "maxPrompt": 272000
      },
      {
        "maxPrompt": 922000,
        "input": 4,
        "read": 0.2,
        "write": 5,
        "output": 15
      }
    ]
  },
  {
    "host": "codex",
    "model": "gpt-6-luna",
    "source": "https://developers.openai.com/api/docs/models/gpt-6-luna",
    "revision": "1e81e2568dbf4bd8",
    "bands": [
      {
        "input": 0.1,
        "read": 0.01,
        "write": 0.125,
        "output": 0.5,
        "maxPrompt": 272000
      },
      {
        "maxPrompt": 922000,
        "input": 0.2,
        "read": 0.02,
        "write": 0.25,
        "output": 0.75
      }
    ]
  },
  {
    "host": "codex",
    "model": "gpt-6-astra",
    "source": "https://developers.openai.com/api/docs/models/gpt-6-astra",
    "revision": "c3a08e324693aad9",
    "bands": [
      {
        "input": 10,
        "read": 1,
        "write": 12.5,
        "output": 50,
        "maxPrompt": 272000
      },
      {
        "maxPrompt": 922000,
        "input": 20,
        "read": 2,
        "write": 25,
        "output": 75
      }
    ]
  }
];
