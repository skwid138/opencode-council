# Council Plugin

An opencode plugin that provides multi-model adversarial review via a `council_review` tool. Multiple reviewer models evaluate the same prompt in parallel; an aggregator synthesizes their findings.

## Language

**Councillor**:
A reviewer instance — one model executing the reviewer agent prompt against the review target.
_Avoid_: Reviewer instance, review agent

**Reviewer agent**:
The agent definition (prompt + permissions) that councillors execute. Either user-specified or the bundled `council-plugin-reviewer`.
_Avoid_: Review prompt, review template

**Aggregator agent**:
The agent that synthesizes councillor responses into deduplicated findings by agreement level. Either user-specified or the bundled `council-plugin-aggregator`.
_Avoid_: Synthesizer, merger

**Bundled agent**:
A default agent injected via config hook when the user doesn't specify a custom agent. Namespaced as `council-plugin-reviewer` or `council-plugin-aggregator`.
_Avoid_: Default agent, built-in agent

**Config hook injection**:
The pattern of injecting agent definitions at plugin startup via the opencode config hook, rather than installing files or passing inline prompts.
_Avoid_: Dynamic registration, runtime injection

**Models array**:
The list of `{ providerID, modelID }` pairs that councillors fan out to. Each model in the array spawns one councillor.
_Avoid_: Reviewer models, councillor models

**Permission override**:
User-specified permissions (`reviewer_permission`, `aggregator_permission`) that merge over bundled agent defaults.
_Avoid_: Permission config, custom permissions

## Relationships

- A **council_review** invocation spawns one **councillor** per entry in the **models array**.
- Each **councillor** executes the **reviewer agent** (bundled or user-specified).
- The **aggregator agent** receives all councillor responses and produces deduplicated findings.
- **Permission overrides** merge over **bundled agent** defaults; user-specified agents bypass bundled agents entirely.

## Example dialogue

> **Dev:** "When I specify `reviewer: 'saruman'` in config, does the plugin still inject `council-plugin-reviewer`?"
> **Domain expert:** "No — user-specified agents fully override bundled agents. The plugin only injects bundled agents when the config omits `reviewer` or `aggregator`."

> **Dev:** "Can I use `reviewer_permission` to add permissions to my custom saruman agent?"
> **Domain expert:** "No — permission overrides only apply to bundled agents. If you specify a custom agent, configure its permissions in the agent definition itself."

## Flagged ambiguities

- "reviewer" was used to mean both the agent definition and a running instance — resolved: **reviewer agent** is the definition; **councillor** is a running instance.
- "default agent" could mean opencode's default agent or the plugin's bundled agent — resolved: use **bundled agent** for plugin-provided defaults.
