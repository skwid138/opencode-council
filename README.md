# @skwid138/opencode-council

Multi-model adversarial review council plugin for opencode

## Install

```sh
npm install @skwid138/opencode-council
```

## Usage

Configure the plugin in `opencode.json`:

```json
{
  "plugin": [
    [
      "@skwid138/opencode-council",
      {
        "council": {
          "reviewer": "reviewer-agent",
          "aggregator": "aggregator-agent",
          "models": [
            { "providerID": "openai", "modelID": "gpt-5.5" },
            { "providerID": "github-copilot", "modelID": "claude-opus-4.6" }
          ],
          "aggregator_model": { "providerID": "openai", "modelID": "gpt-5.5" },
          "timeouts": {
            "councillor_ms": 180000,
            "councillor_retry_ms": 90000,
            "aggregator_ms": 60000,
            "hard_cap_ms": 360000
          }
        }
      }
    ]
  ]
}
```

`aggregator_model` and `timeouts` are optional. Configure at least two model entries.

## License

MIT
