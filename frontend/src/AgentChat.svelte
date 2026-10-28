<script lang="ts">
  import AgentProjectConfirmation from './AgentProjectConfirmation.svelte';
  import {pendingProjectConfirmation} from './agent-confirmation';
  import { onMount, tick, untrack } from 'svelte';
  import {
    Button,
    Search,
    TextArea,
    TextInput,
    InlineNotification,
    OverflowMenu,
    OverflowMenuItem,
    Modal,
  } from 'carbon-components-svelte';
  import Add from 'carbon-icons-svelte/lib/Add.svelte';
  import Time from 'carbon-icons-svelte/lib/Time.svelte';
  import Settings from 'carbon-icons-svelte/lib/Settings.svelte';
  import Copy from 'carbon-icons-svelte/lib/Copy.svelte';
  import Send from 'carbon-icons-svelte/lib/Send.svelte';
  import StopFilledAlt from 'carbon-icons-svelte/lib/StopFilledAlt.svelte';
  import Edit from 'carbon-icons-svelte/lib/Edit.svelte';
  import ArrowDown from 'carbon-icons-svelte/lib/ArrowDown.svelte';
  import ArrowLeft from 'carbon-icons-svelte/lib/ArrowLeft.svelte';
  import MarkdownIt from 'markdown-it';
  import { chatParts } from './chat-parts';
  import { ApiError, api, apiMessage, codedMessage } from './api';
  import EditorChoice from './EditorChoice.svelte';
  import { filterChoice, resultCount } from './ui';
  import { t, locale, type Message, type MessageKey } from './i18n';
  let {
    project,
    viewId = '',
    onSettings,
    onRequestClose,
    onChange,
  }: {
    project: string;
    viewId?: string;
    onSettings: () => void;
    onRequestClose: () => void;
    onChange: () => void | Promise<void>;
  } = $props();
  type Action = {
    id: string;
    name: string;
    args: Record<string, any>;
    status: 'working' | 'awaiting' | 'declined' | 'completed' | 'failed';
    at?: number;
    result?: any;
    error?: string;
  };
  type Turn = {
    id: string;
    seq: number;
    prompt: string;
    response: string;
    actions: Action[];
    status: string;
    error: string;
    errorCode?: string;
  };
  type Conversation = {
    id: string;
    title: string;
    project: string;
    updated: number;
    revision: number;
  };
  const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
  const initial = sessionStorage.getItem('randl.agent.conversation');
  let id = $state(initial || crypto.randomUUID()),
    conversation = $state<Conversation | null>(null),
    turns = $state<Turn[]>([]),
    history = $state<Conversation[]>([]),
    historyOpen = $state(false),
    historySearch = $state(''),
    historyMore = $state(false),
    hasEarlier = $state(false),
    draft = $state(initial ? sessionStorage.getItem('randl.agent.draft:' + initial) || '' : ''),
    editId = $state(''),
    draftBeforeEdit = '',
    error = $state<Message>(''),
    loading = $state(false),
    sending = $state(false),
    busy = $state(false),
    activeConversation = $state<string | null>(null),
    atBottom = $state(true),
    copied = $state(''),
    renameId = $state(''),
    renameText = $state(''),
    deleteId = $state(''),
    models = $state<{ provider: string; providerName: string; id: string; name: string }[]>([]),
    model = $state('automatic'),
    savedModelLabel = $state(''),
    modelChoice = $state('automatic'),
    modelQuery = $state(''),
    modelOpen = $state(false),
    modelRefreshPending = false,
    modelInput = $state<HTMLInputElement | null>(null),
    modelLoading = $state(true),
    modelSaving = $state(false),
    modelError = $state<Message>(''),
    modelErrorTitle = $state<MessageKey>('assistant.chat.modelsLoadFailed');
  let modelRequest = 0;
  let scroller = $state<HTMLDivElement | null>(null),
    input = $state<HTMLTextAreaElement | null>(null),
    historyInput = $state<HTMLInputElement | null>(null),
    historyRequest = 0,
    openRequest = 0,
    historyTimer: ReturnType<typeof setTimeout>,
    copyTimer: ReturnType<typeof setTimeout>,
    alive = true;
  let modelAvailable = $derived(
    model === 'automatic' || models.some((m) => m.provider + '/' + m.id === model),
  );
  let modelItems = $derived([
    { id: 'automatic', text: $t('assistant.model.automatic') },
    ...(!modelAvailable
      ? [
          {
            id: model,
            text: $t('assistant.model.unavailable', { model: savedModelLabel }),
            disabled: true,
          },
        ]
      : []),
    ...models.map((m) => ({ id: m.provider + '/' + m.id, text: m.providerName + ' / ' + m.name })),
  ]);
  const modelNoMatch = $derived(
    modelOpen && !!modelQuery.trim() && !modelItems.some((item) => filterChoice(item, modelQuery)),
  );
  $effect(() => {
    if (!modelOpen && !modelSaving && modelRefreshPending) {
      modelRefreshPending = false;
      untrack(refreshModels);
    }
  });
  async function loadModels() {
    const request = ++modelRequest;
    const result = await api('/api/agent/models');
    if (!alive || request !== modelRequest) return;
    if (modelErrorTitle === 'assistant.chat.modelsLoadFailed') modelError = '';
    models = result.models;
    model = result.selected ? result.selected.provider + '/' + result.selected.id : 'automatic';
    savedModelLabel = result.selectedDetails
      ? result.selectedDetails.providerName + ' / ' + result.selectedDetails.name
      : '';
    modelChoice = model;
    await tick();
    modelQuery = modelItems.find((item) => item.id === model)?.text || '';
    await tick();
    modelLoading = false;
  }
  function refreshModels() {
    // Refreshing rewrites the field, so wait until an open menu closes or a save ends.
    if (modelOpen || modelSaving) modelRefreshPending = true;
    else
      void loadModels().catch((e) => {
        modelErrorTitle = 'assistant.chat.modelsLoadFailed';
        modelError = apiMessage(e);
      });
  }
  async function selectModel(next: string | undefined) {
    if (!next || next === model || modelLoading || modelSaving) return;
    const chosen = models.find((item) => item.provider + '/' + item.id === next);
    if (next !== 'automatic' && !chosen) return;
    modelRequest++;
    modelSaving = true;
    modelError = '';
    modelErrorTitle = 'assistant.settings.model.saveFailed';
    try {
      await api('/api/agent/model', { provider: chosen?.provider || '', id: chosen?.id || '' });
      model = next;
      savedModelLabel = chosen ? chosen.providerName + ' / ' + chosen.name : '';
    } catch (e) {
      modelError = apiMessage(e);
      // This reload replaces any refresh deferred during the save.
      modelRefreshPending = false;
      try {
        await loadModels();
      } catch {
        /* Keep the last confirmed selection visible. */
      }
    } finally {
      modelChoice = model;
      await tick();
      modelQuery = modelItems.find((item) => item.id === model)?.text || '';
      modelSaving = false;
      if (modelRefreshPending && !modelOpen) {
        modelRefreshPending = false;
        refreshModels();
      }
    }
  }
  const draftKey = (key: string) => 'randl.agent.draft:' + key;
  $effect(() => {
    if (draft) sessionStorage.setItem(draftKey(id), draft);
    else sessionStorage.removeItem(draftKey(id));
  });
  function trackConversationScroll(node: HTMLDivElement) {
    let width = node.clientWidth,
      height = node.clientHeight;
    const update = () => {
      if ((width !== node.clientWidth || height !== node.clientHeight) && atBottom)
        node.scrollTop = node.scrollHeight;
      width = node.clientWidth;
      height = node.clientHeight;
      atBottom = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
    };
    const resize = new ResizeObserver(update);
    resize.observe(node);
    node.addEventListener('scroll', update);
    return {
      destroy() {
        resize.disconnect();
        node.removeEventListener('scroll', update);
      },
    };
  }
  function scrollBottom(force = true) {
    void tick().then(() => {
      if (scroller && (force || atBottom)) {
        scroller.scrollTop = scroller.scrollHeight;
        atBottom = true;
      }
    });
  }
  function merge(next: Turn[]) {
    const values = new Map(turns.map((turn) => [turn.id, turn]));
    for (const turn of next) values.set(turn.id, turn);
    turns = [...values.values()].sort((a, b) => a.seq - b.seq);
  }
  async function loadHistory(append = false) {
    const request = ++historyRequest;
    try {
      const result = await api(
        '/api/conversations?search=' +
          encodeURIComponent(historySearch) +
          '&offset=' +
          (append ? history.length : 0),
      );
      if (request !== historyRequest) return;
      history = append ? [...history, ...result.conversations] : result.conversations;
      historyMore = result.conversations.length === 50;
    } catch (e) {
      error = apiMessage(e);
    }
  }
  async function openConversation(next: string) {
    if (sending) return;
    const request = ++openRequest;
    loading = true;
    error = '';
    try {
      const result = await api('/api/conversations/' + encodeURIComponent(next));
      if (request !== openRequest) return;
      id = next;
      conversation = result.conversation;
      turns = result.turns;
      hasEarlier = result.hasEarlier;
      draft = sessionStorage.getItem(draftKey(next)) || '';
      editId = '';
      historyOpen = false;
      sessionStorage.setItem('randl.agent.conversation', id);
      scrollBottom();
    } catch (e) {
      error = apiMessage(e);
      historyOpen = true;
      await loadHistory();
    } finally {
      loading = false;
    }
  }
  function newConversation() {
    if (sending) return;
    openRequest++;
    id = crypto.randomUUID();
    conversation = null;
    turns = [];
    draft = '';
    editId = '';
    error = '';
    hasEarlier = false;
    historyOpen = false;
    sessionStorage.setItem('randl.agent.conversation', id);
    void tick().then(() => input?.focus());
  }
  async function earlier() {
    if (!turns.length || !scroller) return;
    const requestId = id,
      node = scroller,
      height = node.scrollHeight;
    const result = await api('/api/conversations/' + id + '?before=' + turns[0].seq);
    if (id !== requestId) return;
    merge(result.turns);
    hasEarlier = result.hasEarlier;
    await tick();
    node.scrollTop += node.scrollHeight - height;
  }
  async function poll() {
    try {
      const previous = activeConversation,
        status = await api('/api/agent/status');
      busy = status.busy;
      activeConversation = status.conversation;
      if (!sending && (activeConversation === id || previous === id)) {
        const result = await api(
          '/api/conversations/' + id + '?since=' + (conversation?.revision || 0),
        );
        const follow = atBottom;
        merge(result.turns);
        conversation = result.conversation;
        if (follow) scrollBottom(false);
      }
    } catch {
      /* The next status poll resumes after a connection recovers. */
    }
  }
  onMount(() => {
    alive = true;
    draft = sessionStorage.getItem(draftKey(id)) || '';
    refreshModels();
    window.addEventListener('focus', refreshModels);
    if (initial) void openConversation(initial);
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    void tick().then(() => {
      if (alive && !historyOpen && $pendingProjectConfirmation?.session!==id) input?.focus();
    });
    return () => {
      alive = false;
      window.removeEventListener('focus', refreshModels);
      clearInterval(timer);
      clearTimeout(historyTimer);
      clearTimeout(copyTimer);
    };
  });
  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = key;
      clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = ''), 1800);
    } catch (e) {
      error = apiMessage(e);
    }
  }
  function edit(turn: Turn) {
    draftBeforeEdit = draft;
    draft = turn.prompt;
    editId = turn.id;
    input?.focus();
  }
  async function send(retry?: Turn, keyboardRetry = false) {
    const text = retry?.prompt || draft.trim();
    if (!text || busy || sending || modelSaving) return;
    const requestId = id,
      replace = editId;
    error = '';
    sending = true;
    busy = true;
    activeConversation = id;
    let current: Turn | undefined;
    try {
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: id,
          message: text,
          project,
          view: viewId,
          ...(retry ? { retryTurn: retry.id } : replace ? { replaceTurn: replace } : {}),
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new ApiError(data.error, response.status, data.code, data.params);
      }
      sessionStorage.setItem('randl.agent.conversation', id);
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (event.type === 'turn') {
            if (!retry) {
              draft = '';
              editId = '';
            }
            current = event.turn;
            if (replace) {
              const old = turns.find((t) => t.id === replace);
              if (old) turns = turns.filter((t) => t.seq < old.seq);
            }
            merge([current!]);
          } else if (current && event.type === 'text') {
            current.response += event.text;
            merge([{ ...current }]);
          } else if (current && event.type === 'tool_start') {
            current.actions = [
              ...current.actions,
              { id: event.id, name: event.name, args: event.args, status: 'working', at: event.at },
            ];
            merge([{ ...current }]);
          } else if(current && event.type==='confirmation') {
            pendingProjectConfirmation.set({...event,session:requestId,entered:'',submitting:'',error:''});
            current.actions=current.actions.map(action=>action.id===event.id?{...action,status:'awaiting',result:{project:event.project,summary:event.summary}}:action);
            merge([{...current}]);
          } else if (current && event.type === 'tool_end') {
            if(event.name==='project_delete'&&event.status==='completed'&&event.result?.id)window.dispatchEvent(new CustomEvent('randl-project-deleted',{detail:event.result}));
            pendingProjectConfirmation.update(value=>value?.id===event.id?null:value);
            void tick().then(()=>document.getElementById('tool-status-'+current!.id+'-'+event.id)?.closest('summary')?.focus());
            current.actions = current.actions.map((action) =>
              action.id === event.id
                ? {
                    ...action,
                    status: event.status,
                    result: event.result,
                    error: event.errorMessage,
                  }
                : action,
            );
            merge([{ ...current }]);
          } else if (event.type === 'error') {
            if (current) {
              current.status = 'failed';
              current.error = event.text;
              current.errorCode = event.code;
              merge([{ ...current }]);
            } else error = codedMessage(event.code || '', event.params, event.text);
            refreshModels();
          } else if (current && event.type === 'stopped') {
            current.status = 'stopped';
            current.error = '';
            current.errorCode = 'AGENT_REQUEST_STOPPED';
            merge([{ ...current }]);
          } else if (event.type === 'done') {
            current = event.turn;
            merge([event.turn]);
            if (event.turn.status === 'completed' && !modelAvailable) refreshModels();
          }
          if (alive && atBottom) scrollBottom(false);
        }
      }
      if (!current) return;
      const result = await api('/api/conversations/' + requestId);
      if (id === requestId) {
        conversation = result.conversation;
        merge(result.turns);
        hasEarlier = hasEarlier || result.hasEarlier;
      }
      await onChange();
    } catch (e) {
      error = apiMessage(e);
      if (!draft && !retry) draft = text;
    } finally {
      pendingProjectConfirmation.update(value=>value?.session===requestId?null:value);
      sending = false;
      busy = false;
      activeConversation = null;
      await poll();
      if (atBottom) scrollBottom(false);
      await tick();
      if (
        keyboardRetry &&
        alive &&
        id === requestId &&
        !historyOpen &&
        document.activeElement === document.body
      )
        input?.focus();
    }
  }
  const toolName = (name: string) =>
    (
      ({
        workspace_snapshot: 'assistant.tools.workspaceSnapshot',
        runs_list: 'assistant.tools.runs',
        run_get: 'assistant.tools.runDetails',
        metrics_list: 'assistant.tools.metricsList',
        project_create: 'projects.create.action',
        project_update: 'projects.update.action',
        project_get: 'projects.details.title',
        project_delete: 'projects.delete.action',
        view_get: 'assistant.tools.viewGet',
        view_create: 'assistant.tools.viewCreate',
        view_rename: 'assistant.tools.viewRename',
        view_save: 'assistant.tools.viewSave',
        view_delete: 'assistant.tools.viewDelete',
        panel_add: 'assistant.tools.panelAdd',
        panel_update: 'assistant.tools.panelUpdate',
        panel_remove: 'assistant.tools.panelRemove',
        runs_select: 'assistant.tools.runs',
        plugins_list: 'assistant.tools.pluginsList',
        runs_update: 'assistant.tools.runs',
      }) as Record<string, MessageKey>
    )[name] || { text: name };
</script>

<div class="assistant-chat">
  <div class="conversation-toolbar">
    {#if historyOpen}<Button
        kind="ghost"
        size="small"
        icon={ArrowLeft}
        hideTooltip
        title={$t('assistant.conversations.back')}
        iconDescription={$t('assistant.conversations.back')}
        on:click={() => (historyOpen = false)}
      />{/if}
    <span
      class="conversation-title"
      title={historyOpen
        ? $t('assistant.conversations.history')
        : conversation?.title || $t('assistant.conversations.untitled')}
      >{historyOpen
        ? $t('assistant.conversations.history')
        : conversation?.title || $t('assistant.conversations.untitled')}</span
    >
    <Button
      kind="ghost"
      size="small"
      icon={Time}
      hideTooltip
      title={$t('assistant.conversations.history')}
      iconDescription={$t('assistant.conversations.history')}
      on:click={() => {
        historyOpen = !historyOpen;
        if (historyOpen) void loadHistory();
      }}
    />
    <Button
      kind="ghost"
      size="small"
      icon={Add}
      disabled={sending}
      hideTooltip
      title={$t('assistant.conversations.new')}
      iconDescription={$t('assistant.conversations.new')}
      on:click={newConversation}
    />
    <Button
      kind="ghost"
      size="small"
      icon={Settings}
      hideTooltip
      title={$t('assistant.chat.settings')}
      iconDescription={$t('assistant.chat.settings')}
      on:click={onSettings}
    />
  </div>
  {#if error}<InlineNotification
      kind="error"
      closeButtonDescription={$t('common.notification.close')}
      title={$t('assistant.errors.requestFailed')}
      subtitle={$t(error)}
      on:close={() => (error = '')}
    />{/if}
  {#if historyOpen}
    <Search
      labelText={$t('assistant.conversations.search')}
      placeholder={$t('assistant.conversations.search')}
      closeButtonLabelText={$t('common.search.clear')}
      size="sm"
      bind:value={historySearch}
      bind:ref={historyInput}
      on:input={() => {
        clearTimeout(historyTimer);
        historyTimer = setTimeout(() => void loadHistory(), 200);
      }}
    />
    <div class="conversation-history">
      {#if !history.length}<p>
          {$t(historySearch ? 'assistant.conversations.noMatches' : 'assistant.conversations.empty')}
        </p>{/if}
      {#each history as item (item.id)}<div class="conversation-row" data-conversation-id={item.id}>
          {#if renameId === item.id}<form
              onsubmit={async (event) => {
                event.preventDefault();
                try {
                  await api('/api/conversations/' + item.id, { title: renameText }, 'PATCH');
                  renameId = '';
                  await loadHistory();
                  if (conversation?.id === item.id)
                    conversation = { ...conversation, title: renameText };
                } catch (e) {
                  error = apiMessage(e);
                }
              }}
            >
              <TextInput
                labelText={$t('assistant.conversations.rename')}
                bind:value={renameText}
                maxlength={200}
              />
              <div>
                <Button size="small" type="submit" disabled={!renameText.trim()}
                  >{$t('assistant.conversations.renameSave')}</Button
                ><Button kind="ghost" size="small" on:click={() => (renameId = '')}
                  >{$t('common.action.cancel')}</Button
                >
              </div>
            </form>
          {:else}<button
              type="button"
              class="conversation-link"
              disabled={sending}
              onclick={() => openConversation(item.id)}
              ><strong>{item.title || $t('assistant.conversations.untitled')}</strong><time
                >{new Intl.DateTimeFormat($locale, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(item.updated)}</time
              ></button
            ><OverflowMenu
              flipped
              size="sm"
              aria-label={$t('assistant.conversations.actions', { name: item.title })}
              iconDescription={$t('assistant.conversations.actions', { name: item.title })}
              ><OverflowMenuItem
                text={$t('assistant.conversations.rename')}
                on:click={() => {
                  renameId = item.id;
                  renameText = item.title;
                  void tick().then(() =>
                    document
                      .querySelector<HTMLInputElement>(
                        '[data-conversation-id="' + item.id + '"] input',
                      )
                      ?.focus(),
                  );
                }}
              /><OverflowMenuItem
                text={$t('assistant.conversations.delete')}
                danger
                hasDivider
                disabled={activeConversation === item.id}
                on:click={() => {
                  document
                    .querySelector<HTMLElement>(
                      `[data-conversation-id="${CSS.escape(item.id)}"] .bx--overflow-menu`,
                    )
                    ?.focus();
                  deleteId = item.id;
                }}
              /></OverflowMenu
            >{/if}
        </div>{/each}
      {#if historyMore}<Button kind="ghost" size="small" on:click={() => loadHistory(true)}
          >{$t('assistant.conversations.loadMore')}</Button
        >{/if}
    </div>
  {:else}
    <div class="chat-transcript">
      <div class="agent-messages" bind:this={scroller} use:trackConversationScroll>
        {#if hasEarlier}<Button kind="ghost" size="small" on:click={earlier}
            >{$t('assistant.chat.loadEarlier')}</Button
          >{/if}
        {#if loading}<p role="status">{$t('common.status.loading')}</p>{/if}
        {#each turns as turn (turn.id)}
          <article class="chat-message user-message">
            <strong>{$t('assistant.chat.user')}</strong>
            <p>{turn.prompt}</p>
            <div class="message-actions">
              <Button
                kind="ghost"
                size="small"
                icon={Copy}
                hideTooltip
                title={$t('assistant.chat.copyMessage')}
                iconDescription={$t('assistant.chat.copyMessage')}
                on:click={() => copy(turn.prompt, turn.id + '-user')}
              /><Button
                kind="ghost"
                size="small"
                icon={Edit}
                disabled={busy}
                hideTooltip
                title={$t('assistant.chat.editMessage')}
                iconDescription={$t('assistant.chat.editMessage')}
                on:click={() => edit(turn)}
              />{#if copied === turn.id + '-user'}<span role="status">{$t('common.status.copied')}</span>{/if}
            </div>
          </article>
          <article class="chat-message assistant-message">
            <strong>{$t('assistant.chat.assistant')}</strong>
            {#each chatParts(turn.response || '', turn.actions) as part (part.key)}{#if part.kind === 'text'}<div
                  class="chat-markdown"
                >
                  {@html markdown.render(part.text)}
                </div>{:else}<div class="chat-tool-actions">
                  {#each part.actions as action (action.id)}{#if action.status === 'awaiting' && action.name === 'project_delete'}<AgentProjectConfirmation
                        {action}
                        session={id}
                      />{:else}<details class:failed={action.status === 'failed'}>
                        <summary
                          ><span>{$t(toolName(action.name))}</span><span
                            id={'tool-status-' + turn.id + '-' + action.id}
                            tabindex="-1"
                            >{$t(
                              action.status === 'working'
                                ? 'assistant.tools.status.working'
                                : action.status === 'declined'
                                  ? 'projects.confirmation.declined'
                                  : action.status === 'failed'
                                    ? 'assistant.tools.status.failed'
                                    : 'assistant.tools.status.completed',
                            )}</span
                          ></summary
                        >{#if action.error}<p role="alert">{action.error}</p>{/if}
                        <pre>{JSON.stringify(
                            {
                              arguments: action.args,
                              ...(action.result === undefined ? {} : { result: action.result }),
                            },
                            null,
                            2,
                          )}</pre>
                      </details>{/if}{/each}
                </div>{/if}{/each}

            {#if turn.status === 'working'}<p role="status">
                {$t('assistant.chat.generating')}
              </p>{:else if turn.status === 'failed' || turn.status === 'stopped'}<div
                class="chat-turn-error"
                role="status"
              >
                <p>
                  {$t(
                    turn.errorCode
                      ? codedMessage(turn.errorCode, {}, turn.error)
                      : turn.error
                        ? { text: turn.error }
                        : 'assistant.errors.requestFailed',
                  )}
                </p>
                {#if turn.id === turns.at(-1)?.id}<Button
                    kind="ghost"
                    size="small"
                    disabled={busy}
                    on:click={(event) => send(turn, event.detail === 0)}
                    >{$t('assistant.chat.continue')}</Button
                  >{/if}
              </div>{/if}
            {#if turn.response}<div class="message-actions">
                <Button
                  kind="ghost"
                  size="small"
                  icon={Copy}
                  hideTooltip
                  title={$t('assistant.chat.copyMessage')}
                  iconDescription={$t('assistant.chat.copyMessage')}
                  on:click={() => copy(turn.response, turn.id)}
                />{#if copied === turn.id}<span role="status">{$t('common.status.copied')}</span>{/if}
              </div>{/if}
          </article>
        {/each}
      </div>
      {#if !atBottom}<Button
          class="jump-to-messages"
          kind="tertiary"
          size="small"
          icon={ArrowDown}
          on:click={(event) => {
            scrollBottom();
            if (event.detail === 0) input?.focus({ preventScroll: true });
          }}>{$t('assistant.chat.jumpToLatest')}</Button
        >{/if}
    </div>
    <form
      class="chat-composer"
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {#if editId}<div class="edit-message-notice">
          <span>{$t('assistant.chat.editWarning')}</span
          ><Button
            kind="ghost"
            size="small"
            on:click={() => {
              editId = '';
              draft = draftBeforeEdit;
            }}>{$t('common.action.cancel')}</Button
          >
        </div>{/if}
      <TextArea
        labelText={$t('assistant.chat.messageLabel')}
        bind:value={draft}
        bind:ref={input}
        rows={3}
        maxlength={12000}
        on:keydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div class="chat-composer-controls">
        <EditorChoice
          labelText={$t('assistant.chat.model')}
          size="sm"
          items={modelItems}
          bind:selectedId={modelChoice}
          bind:value={modelQuery}
          bind:open={modelOpen}
          bind:ref={modelInput}
          {onRequestClose}
          disabled={busy || modelLoading}
          readonly={modelSaving}
          clearFilterOnOpen
          filterResultsText={(count) => resultCount(count, $t, 'common.combobox.noMatches')}
          on:select={(event) =>
            void selectModel(event.detail.selectedId ? String(event.detail.selectedId) : undefined)}
          on:blur={() => {
            if (!modelChoice) {
              modelChoice = model;
              modelQuery = modelItems.find((item) => item.id === model)?.text || '';
            }
          }}
        />
        {#if busy}<Button
            kind="secondary"
            size="small"
            icon={StopFilledAlt}
            hideTooltip
            title={$t('assistant.chat.stop')}
            iconDescription={$t('assistant.chat.stop')}
            on:click={() => api('/api/agent/cancel', { session: activeConversation || id })}
          />{:else}<Button
            size="small"
            type="submit"
            icon={Send}
            hideTooltip
            title={$t('assistant.chat.send')}
            iconDescription={$t('assistant.chat.send')}
            disabled={!draft.trim() || modelSaving || modelLoading}
          />{/if}
      </div>
      {#if modelNoMatch}<p role="status">{$t('common.combobox.noMatches')}</p>{/if}
      {#if modelError}<InlineNotification
          kind="error"
          closeButtonDescription={$t('common.notification.close')}
          title={$t(modelErrorTitle)}
          subtitle={$t(modelError)}
          on:close={() => {
            modelError = '';
            modelInput?.focus();
          }}
        />{/if}
      {#if !models.length}<Button kind="ghost" size="small" on:click={onSettings}
          >{$t('assistant.chat.configure')}</Button
        >{:else if !modelAvailable}<p role="status">{$t('assistant.errors.modelUnavailable')}</p>{/if}
    </form>
  {/if}
</div>
<Modal
  open={!!deleteId}
  size="xs"
  danger
  modalHeading={$t('assistant.conversations.deleteConfirm.title')}
  primaryButtonText={$t('assistant.conversations.delete')}
  secondaryButtonText={$t('common.action.cancel')}
  iconDescription={$t('common.action.close')}
  on:close={() => (deleteId = '')}
  on:click:button--secondary={() => (deleteId = '')}
  on:submit={async () => {
    try {
      await api('/api/conversations/' + deleteId, undefined, 'DELETE');
      const deletedCurrent = deleteId === id;
      if (deletedCurrent) newConversation();
      deleteId = '';
      await loadHistory();
      await tick();
      if (!deletedCurrent) historyInput?.focus();
    } catch (e) {
      error = apiMessage(e);
    }
  }}><p>{$t('assistant.conversations.deleteConfirm.body')}</p></Modal
>
