# 🧞 Jinn

> A lightweight AI gateway daemon that orchestrates professional AI coding CLIs — **Claude Code, Codex, Grok, and Antigravity** — behind one unified process. Jinn is a bus, not a brain.

[![npm version](https://img.shields.io/npm/v/jinn-cli.svg)](https://www.npmjs.com/package/jinn-cli)
[![license: MIT](https://img.shields.io/npm/l/jinn-cli.svg)](https://github.com/hristo2612/jinn)
[![node](https://img.shields.io/node/v/jinn-cli.svg)](https://github.com/hristo2612/jinn)

<p align="center">
  <img src="https://raw.githubusercontent.com/hristo2612/jinn/main/assets/jinn-showcase.gif" alt="Jinn web dashboard" width="800" />
</p>

## What is Jinn?

Jinn is an open-source AI gateway that wraps battle-tested AI coding CLIs — **Claude Code, Codex, Grok, and Antigravity** — behind a single daemon. It routes tasks to the right engine, runs a hierarchical org of AI "employees", schedules background work with cron, talks to your tools through connectors, and ships a full web dashboard and voice mode — all on top of the official CLIs you already trust.

**Jinn is a bus, not a brain.** Most AI agent frameworks reinvent the wheel — custom tool-calling loops, brittle context management, hand-rolled retries — and bill you per token on top. Jinn instead delegates to the professional CLIs and adds only what they're missing: routing, an org system, scheduling, connectors, and a UI.

## 🔑 Works with your Claude Max subscription

Because Jinn drives the **official Claude Code CLI** under the hood, it works with the flat-rate Anthropic Max subscription — no per-token API billing, no surprise invoices. Third-party agent frameworks were banned from using Max OAuth tokens in January 2026; since Jinn delegates to Anthropic's first-party CLI, it stays fully supported.

## 🚀 Quick start

Install at least one engine CLI first:

- **Claude Code** — `npm install -g @anthropic-ai/claude-code`
- **Codex** (optional) — `npm install -g @openai/codex`

Then:

```bash
npm install -g jinn-cli
jinn setup     # interactive first-run setup (name your portal, pick your engine)
jinn start     # start the gateway daemon + web dashboard
```

Or via Homebrew:

```bash
brew install jinn
jinn setup && jinn start
```

> Sign in to your engines once before `jinn start` — run `claude` and use `/login` (and `codex` if installed).

## ✨ Features

- **Multi-engine** — Claude Code, Codex, Grok, and Antigravity behind one API; switch engine and model per task or per employee.
- **AI org system** — hierarchical "employees" with personas, ranks, and departments. Delegate work down the tree; results flow back up through a COO.
- **Cron & background jobs** — schedule recurring agent work and long-running tasks; review the output before it reaches you.
- **Connectors** — Slack and more, so your agents can message, report, and act.
- **Web dashboard + voice** — chat UI, live org chart, kanban board, logs, usage limits, and a hands-free talk mode.
- **Skills** — reusable Markdown playbooks your agents follow step by step.
- **Subscription-friendly** — every Claude turn runs through the real interactive CLI inside a PTY, so your Max plan keeps working instead of silently draining API credits.

## 📚 Documentation

Full documentation, architecture notes, and roadmap live in the repository:

**→ https://github.com/hristo2612/jinn**

## License

[MIT](https://github.com/hristo2612/jinn)
