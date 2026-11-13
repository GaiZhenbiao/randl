# The Assistant

The Assistant is an optional chat in the dashboard that sets up the workspace for you. It reads
your runs and builds views, panels and run selections with the same
[tools](../reference/tools.md) as the dashboard and the CLI, and each change is an ordinary
saved view you can keep editing.

## Using it

Open **Assistant** in the header and describe what you want:

- "Compare my three best runs on episodic return." It reads the summaries, creates a view with
  a return chart and solos the three runs.
- "Add a panel for the value loss grouped by learning rate." It adds a line chart to the open
  view, grouped by the `learning_rate` config value.
- "Tag the crashed runs as unstable and hide them."

The Assistant knows which project and view you have open. Each tool call is listed in the
conversation as it runs. Conversations are kept under **Conversation history**.

From a terminal, `randl agent` sends one request and prints the reply, with each tool call on
standard error:

```sh
randl agent 'Compare my three best runs on episodic return'
```

## What it can and cannot do

- It loads only randl's management tools. It has no shell or file access and does not load
  project instructions, skills or extensions from the server's working directory.
- It cannot use the ledger and planning tools, change server settings such as the media limit,
  or edit stored history (the tools marked "Not available to the Assistant" in the
  [tool reference](../reference/tools.md)).
- Deleting a project needs your confirmation: a card in the conversation waits for you to type
  the project's name, and the model cannot confirm it. `randl agent` declines deletions unless
  you pass `--confirm-delete-project entity/project`.
- Runs it deletes can be restored from the project's settings.

Prompts and tool results are sent to the model's provider.

## Choosing a provider

The Assistant is built on the Pi coding agent. In **App settings → Assistant**, save an API key
for a provider (Anthropic, OpenAI, Google, Mistral, OpenRouter or another provider Pi
supports) and choose a model, or **Automatic**. **Test connection** sends a short request, which
may be billed.

- Keys are stored unencrypted in `<data-dir>/pi/auth.json` (mode `0600`), so backups of the
  data directory include them.
- Providers that need an OAuth sign-in or extra fields are configured with the Pi CLI on the
  server: expand **Sign in or configure with Pi**, copy the command, enter `/login` in Pi, then
  choose **Refresh providers**.
- Custom endpoints go in the profile's `models.json`.
- To share credentials with an existing Pi installation, start the server with
  `--pi-agent-dir /path/to/profile` (or `RANDL_PI_AGENT_DIR`). Saving or removing keys in randl
  then changes that profile. Provider environment variables remain available to Pi.

## Conversations, retries and failures

- Each turn shows response text and tool calls in the order they ran, during streaming and after
  reload.
- Only the last failed or stopped turn can be retried. A retry continues from the messages and
  tool results already in the conversation; completed tool changes stay saved.
- Editing an earlier turn replaces it and every later message. It does not undo tool changes.
- Changing the model applies to later requests and keeps the conversation.
- A tool call waiting for confirmation is declined if you stop the request, close the tab or
  lose the connection. A declined call never changes data.
- If the chosen model becomes unavailable, sending fails with a message in your language; choose
  another model or reconnect the provider.
