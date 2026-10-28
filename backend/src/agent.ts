import { ProjectConfirmations } from './agent-confirmations.js';
import { managementError, isManagementCode, type ErrorFields } from './management-errors.js';
import { PiProfile } from './pi-profile.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ChatTurn } from './conversations.js';
import type { Tools } from './tools.js';
import { toolCatalog } from './tools.js';
import type {
  AgentSession,
  SessionManager,
  ModelRuntime,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
const serverSetupProviders = new Set([
  'amazon-bedrock',
  'google-vertex',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
]);
export class Agent {
  private runtime?: Promise<ModelRuntime>;
  private getRuntime() {
    return (this.runtime ||= this.runtimeFactory().catch(() => {
      this.runtime = undefined;
      throw managementError(
        'AGENT_SETTINGS_UNAVAILABLE',
        'Assistant settings could not be loaded. Check the server configuration.',
      );
    }));
  }

  private refreshing?: Promise<void>;
  private async refreshedRuntime() {
    const runtime = await this.getRuntime();
    // Settings and chat await the same completed Pi availability snapshot.
    this.refreshing ||= runtime
      .refresh({ allowNetwork: false })
      .then(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
    return runtime;
  }

  private knownKeys = new Map<string, string>();
  private redact(value: string) {
    for (const key of this.knownKeys.values()) {
      if (key.length < 8 && value.includes(key)) return 'Model provider request failed.';
      value = value.replaceAll(key, '[redacted]');
    }
    for (const path of [
      this.profile.directory,
      resolve(this.dataDirectory),
      process.cwd(),
      homedir(),
    ])
      if (path.length > 1) value = value.replaceAll(path, '[server directory]');
    return value;
  }
  /** A failure safe to show: coded errors keep their code, provider text is redacted. */
  private failure(error: unknown): ErrorFields {
    const message = typeof error === 'string' ? error : (error as Error).message,
      code = (error as ErrorFields).code;
    if (
      code === 'oauth' ||
      /^(OAuth refresh failed for |OAuth refresh returned a token that expires too soon for |OAuth auth derivation failed for )/.test(
        message,
      )
    )
      return managementError(
        'AGENT_OAUTH_REFRESH',
        'Could not refresh the browser sign-in for this provider. Try again, or sign in again with Pi on the randl server.',
      );
    if (isManagementCode(code)) return error as ErrorFields;
    return Error(this.redact(message));
  }
  private errorMessage(error: unknown) {
    return this.failure(error).message;
  }
  private async checkpoint(id: string, manager: SessionManager) {
    const entries = structuredClone([manager.getHeader(), ...manager.getEntries()]);
    for (const item of entries)
      if (
        item &&
        item.type === 'message' &&
        item.message.role === 'assistant' &&
        item.message.errorMessage
      )
        item.message.errorMessage = this.errorMessage(item.message.errorMessage);
    await this.tools.db.call('chatCheckpoint', { id, entries });
  }
  private async configure<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy)
      throw managementError('AGENT_BUSY', 'Stop the active request before changing agent settings');
    this.busy = true;
    try {
      return await operation();
    } catch (error) {
      throw this.failure(error);
    } finally {
      this.busy = false;
    }
  }
  selectedModel?: { provider: string; id: string };
  async models() {
    this.selectedModel ||= (await this.tools.db.call('settingGet', 'agent-model')) || undefined;
    const runtime = await this.refreshedRuntime();
    const selected =
      this.selectedModel && runtime.getModel(this.selectedModel.provider, this.selectedModel.id);
    const providerName = (provider: string) => runtime.getProvider(provider)?.name || provider;
    return {
      models: runtime
        .getAvailableSnapshot()
        .map((m) => ({
          provider: m.provider,
          providerName: providerName(m.provider),
          id: m.id,
          name: m.name || m.id,
        })),
      selected: this.selectedModel || null,
      selectedDetails: this.selectedModel
        ? {
            providerName: providerName(this.selectedModel.provider),
            name: selected?.name || this.selectedModel.id,
          }
        : null,
      automatic: await this.automaticModel(runtime).then((model) =>
        model ? { provider: model.provider, id: model.id, name: model.name } : null,
      ),
    };
  }
  private async automaticModel(runtime: ModelRuntime) {
    const settings = await this.profile.settings();
    const available = runtime.getAvailableSnapshot();
    return (
      available.find(
        (model) =>
          model.provider === settings.getDefaultProvider() &&
          model.id === settings.getDefaultModel(),
      ) || available[0]
    );
  }
  async select(model: { provider: string; id: string }) {
    return this.configure(async () => {
      const runtime = await this.refreshedRuntime();
      const automatic = !model.provider && !model.id;
      const selected = automatic
        ? await this.automaticModel(runtime)
        : runtime.getModel(model.provider, model.id);
      if (
        !automatic &&
        (!selected ||
          !runtime
            .getAvailableSnapshot()
            .some((item) => item.provider === selected.provider && item.id === selected.id))
      )
        throw managementError('AGENT_MODEL_UNAVAILABLE', 'Selected model is unavailable.');
      if (selected)
        for (const entry of this.sessions.values()) await entry.session.setModel(selected);
      this.selectedModel = automatic ? undefined : model;
      await this.tools.db.call('settingSet', 'agent-model', this.selectedModel || null);
      return this.selectedModel || null;
    });
  }
  async providers() {
    const runtime = await this.refreshedRuntime();
    const stored = new Map(
      (await runtime.listCredentials()).map((item) => [item.providerId, item.type]),
    );
    return {
      configuration: this.profile.information(),
      providers: runtime
        .getProviders()
        .map((provider) => ({
          id: provider.id,
          name: provider.name,
          apiKey: !!provider.auth.apiKey?.login && !serverSetupProviders.has(provider.id),
          serverSetup:
            serverSetupProviders.has(provider.id) ||
            (!!provider.auth.apiKey && !provider.auth.apiKey.login),
          oauth: !!provider.auth.oauth,
          configured: runtime.hasConfiguredAuth(provider.id),
          stored: stored.get(provider.id) === 'api_key',
          credentialType: stored.get(provider.id) || null,
          credentialSource: runtime.getProviderAuthStatus(provider.id).source || null,
          models: runtime
            .getModels(provider.id)
            .map((model) => ({ id: model.id, name: model.name })),
        }))
        .filter((provider) => provider.models.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  async credential(provider: string, key?: string) {
    return this.configure(async () => {
      const runtime = await this.getRuntime(),
        item = runtime.getProvider(provider);
      if (!item) throw managementError('AGENT_PROVIDER_UNKNOWN', 'Unknown model provider');
      if (key !== undefined) {
        if (!key.trim()) throw managementError('AGENT_API_KEY_REQUIRED', 'Enter an API key');
        if (serverSetupProviders.has(provider) || (item.auth.apiKey && !item.auth.apiKey.login))
          throw managementError(
            'AGENT_PROVIDER_SERVER_SETTINGS',
            'This provider needs additional settings on the randl server.',
          );
        if (!item.auth.apiKey)
          throw managementError(
            'AGENT_PROVIDER_BROWSER_SIGN_IN',
            'This provider uses a browser sign-in. Connect it with Pi on the server.',
          );
        const previousKey = this.knownKeys.get(provider);
        this.knownKeys.set(provider, key.trim());
        let answered = false;
        try {
          await runtime.login(provider, 'api_key', {
            prompt: async (prompt) => {
              if (answered || !['secret', 'text'].includes(prompt.type))
                throw managementError(
                  'AGENT_PROVIDER_PI_SETTINGS',
                  'This provider needs additional settings. Configure it with Pi on the server.',
                );
              answered = true;
              const literal = key.trim().replaceAll('$', () => '$$');
              return literal.startsWith('!') ? '$' + literal : literal;
            },
            notify: () => {},
          });
        } catch (error) {
          const failure = this.failure(error);
          if (previousKey === undefined) this.knownKeys.delete(provider);
          else this.knownKeys.set(provider, previousKey);
          throw failure;
        }
      } else {
        await runtime.logout(provider);
        this.knownKeys.delete(provider);
      }
      return { saved: key !== undefined };
    });
  }
  async testConnection(provider: string, id: string) {
    return this.configure(async () => {
      const runtime = await this.getRuntime(),
        model = runtime.getModel(provider, id);
      if (!model) throw managementError('AGENT_MODEL_REQUIRED', 'Choose a model');
      const auth = await runtime.getAuth(model);
      if (auth?.auth.apiKey) this.knownKeys.set(provider, auth.auth.apiKey);
      const result = await runtime.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] },
        { maxTokens: 32, signal: AbortSignal.timeout(30000) },
      );
      if (result.stopReason === 'error' || result.stopReason === 'aborted')
        throw result.errorMessage
          ? Error(result.errorMessage)
          : managementError(
              'AGENT_TEST_INCOMPLETE',
              'The model did not complete the connection test',
            );
      return { ok: true };
    });
  }
  sessions = new Map<string, { session: AgentSession; manager: SessionManager; last: number }>();
  busy = false;
  active?: AgentSession;
  activeId?: string;
  private cancelRequested = false;
  readonly profile: PiProfile;
  readonly confirmations:ProjectConfirmations;
  runtimeFactory: () => Promise<ModelRuntime>;
  constructor(
    readonly tools: Tools,
    readonly dataDirectory: string,
    piAgentDirectory?: string,
    runtimeFactory?: () => Promise<ModelRuntime>,
  ) {
    this.confirmations=new ProjectConfirmations(tools);
    this.profile = new PiProfile(dataDirectory, piAgentDirectory);
    this.runtimeFactory = runtimeFactory || (() => this.profile.runtime());
  }
  async chat(
    id: string,
    message: string,
    emit: (event: any) => void,
    options: { project?: string; view?: string; replaceTurn?: string; retryTurn?: string } = {},
  ) {
    if (this.busy) throw Error('Agent is busy; wait or cancel the active request');
    this.busy = true;
    this.activeId = id;
    this.cancelRequested = false;
    let turn: ChatTurn | undefined,
      writeTask: Promise<any> = Promise.resolve(),
      writing = false,
      writeTimer: ReturnType<typeof setInterval> | undefined,
      timedOut = false;
    try {
      if (options.replaceTurn) {
        await this.tools.db.call('chatReplace', { id, turn: options.replaceTurn });
        this.sessions.get(id)?.session.dispose();
        this.sessions.delete(id);
      }
      await this.tools.db.call('chatEnsure', {
        id,
        title: message.trim().split('\n')[0].slice(0, 100),
        project: options.project || '',
      });
      if (options.retryTurn) {
        const history = await this.tools.db.call('chatGet', { id }),
          candidate: ChatTurn | undefined = history.turns.at(-1);
        if (
          !candidate ||
          candidate.id !== options.retryTurn ||
          !['failed', 'stopped'].includes(candidate.status)
        )
          throw managementError('AGENT_RETRY_UNAVAILABLE', 'Request cannot be retried');
        const entries = await this.tools.db.call('chatEntries', id);
        if (
          candidate.parentEntry &&
          !entries.some((item: any) => item.id === candidate.parentEntry)
        )
          throw managementError(
            'AGENT_CONTEXT_UNAVAILABLE',
            'The saved request context is unavailable. Start a new conversation.',
          );
        turn = candidate;
        turn.status = 'working';
        turn.error = '';
        turn.errorCode = '';
        // Continued text starts a new paragraph after the saved partial response.
        if (turn.response) turn.response += '\n\n';
      } else {
        turn = await this.tools.db.call('chatAppend', { id, prompt: message });
      }
      emit({ type: 'turn', turn });
      this.selectedModel ||= (await this.tools.db.call('settingGet', 'agent-model')) || undefined;
      const requestedRuntime = await this.refreshedRuntime();
      const requestedModel = this.selectedModel
        ? requestedRuntime.getModel(this.selectedModel.provider, this.selectedModel.id)
        : await this.automaticModel(requestedRuntime);
      if (
        this.selectedModel &&
        (!requestedModel ||
          !requestedRuntime
            .getAvailableSnapshot()
            .some(
              (model) =>
                model.provider === this.selectedModel!.provider &&
                model.id === this.selectedModel!.id,
            ))
      )
        throw managementError('AGENT_MODEL_UNAVAILABLE', 'Selected model is unavailable.');
      if (!requestedModel)
        throw managementError(
          'AGENT_PROVIDER_REQUIRED',
          'Connect a provider in Assistant settings.',
        );
      const pi = await import('@earendil-works/pi-coding-agent');
      for (const [key, value] of this.sessions)
        if (Date.now() - value.last > 20 * 60 * 1000) {
          value.session.dispose();
          this.sessions.delete(key);
        }
      let entry = this.sessions.get(id);
      if (!entry) {
        if (this.sessions.size >= 4) {
          const key = this.sessions.keys().next().value!;
          this.sessions.get(key)!.session.dispose();
          this.sessions.delete(key);
        }
        const resourceLoader = await this.profile.resources();
        const customTools = toolCatalog.map((t) => ({
          ...t,
          label: t.name,
          parameters: (t.agentParameters||t.parameters) as ToolDefinition['parameters'],
          ...(t.tier==='confirm'?{executionMode:'sequential' as const}:{}),
          execute: async (call: string, args: any, signal?:AbortSignal) => {
            const result=t.tier==='confirm'?await this.confirmations.request(call,args,signal):await this.tools.execute(t.name,args);
            return {content:[{type:'text' as const,text:JSON.stringify(result)}],details:{}};
          },
        }));
        const auth = await requestedRuntime.getAuth(requestedModel);
        if (auth?.auth.apiKey) this.knownKeys.set(requestedModel.provider, auth.auth.apiKey);
        const manager = pi.SessionManager.inMemory(
          this.profile.directory,
          undefined,
          await this.tools.db.call('chatEntries', id),
        );
        const { session } = await pi.createAgentSession({
          cwd: this.profile.directory,
          agentDir: this.profile.directory,
          modelRuntime: requestedRuntime,
          model: requestedModel,
          tools: toolCatalog.map((t) => t.name),
          customTools,
          resourceLoader,
          sessionManager: manager,
          settingsManager: await this.profile.settings(),
        });
        if (session.model) {
          const auth = await requestedRuntime.getAuth(session.model);
          if (auth?.auth.apiKey) this.knownKeys.set(session.model.provider, auth.auth.apiKey);
        }
        entry = { session, manager, last: Date.now() };
        this.sessions.set(id, entry);
      }
      if (
        entry.session.model?.provider !== requestedModel.provider ||
        entry.session.model?.id !== requestedModel.id
      )
        await entry.session.setModel(requestedModel);
      await this.tools.db.call('chatUpdate', turn);
      writeTimer = setInterval(() => {
        if (writing || !turn) return;
        writing = true;
        writeTask = this.tools.db
          .call('chatUpdate', structuredClone(turn))
          .catch(() => {})
          .finally(() => (writing = false));
      }, 500);
      this.active = entry.session;
      this.activeId = id;
      entry.last = Date.now();
      if (entry.session.model) {
        const model = entry.session.model,
          auth = await (await this.getRuntime()).getAuth(model);
        if (auth?.auth.apiKey) this.knownKeys.set(model.provider, auth.auth.apiKey);
      }
      const unsubscribe = entry.session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          const text = event.assistantMessageEvent.delta;
          turn!.response += text;
          emit({ type: 'text', text });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (event.message.stopReason === 'error') {
            turn!.status = 'failed';
            const failure = this.failure(
              event.message.errorMessage || 'Model provider request failed.',
            );
            turn!.error = failure.message;
            turn!.errorCode = failure.code || '';
            emit({ type: 'error', text: turn!.error, code: turn!.errorCode || undefined });
          } else if (event.message.stopReason === 'aborted') {
            turn!.status = timedOut ? 'failed' : 'stopped';
            turn!.error = timedOut ? 'Request timed out.' : 'Request stopped';
            turn!.errorCode = timedOut ? 'AGENT_REQUEST_TIMEOUT' : 'AGENT_REQUEST_STOPPED';
            emit({
              type: timedOut ? 'error' : 'stopped',
              text: turn!.error,
              code: turn!.errorCode,
            });
          } else if (turn!.response && !turn!.response.endsWith('\n\n')) {
            turn!.response += '\n\n';
            emit({ type: 'text', text: '\n\n' });
          }
        }
        // Pi completes the assistant message (including text after tool-call
        // declarations) before executing its tools. Anchor operations here.
        if (event.type === 'tool_execution_start') {
          const action = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: 'working' as const,
            at: turn!.response.length,
          };
          turn!.actions.push(action);
          emit({ type: 'tool_start', ...action });
        }
        if (event.type === 'tool_execution_end') {
          const action = turn!.actions.find((item) => item.id === event.toolCallId);
          if (action) {
            action.status = event.isError ? 'failed' : 'completed';
            const text = event.result.content
              .filter((item: any) => item.type === 'text')
              .map((item: any) => item.text)
              .join('\n');
            if (event.isError) action.error = this.redact(text);
            else {
              try {
                action.result = JSON.parse(text);
                if((action.result as any)?.declined)action.status='declined';
              } catch {
                action.result = text;
              }
            }
            emit({ type: 'tool_end', ...action, error: event.isError, errorMessage: action.error });
          }
        }
      });
      let remaining=120000, started=Date.now(), timeout:ReturnType<typeof setTimeout>|undefined;
      const resume=()=>{started=Date.now();timeout=setTimeout(()=>{timedOut=true;void entry!.session.abort();},remaining);};
      const pause=()=>{if(timeout){clearTimeout(timeout);timeout=undefined;remaining=Math.max(0,remaining-(Date.now()-started));}};
      this.confirmations.begin({session:id,turn:turn!,emit,pause,resume});
      resume();
      try {
        const context =
          options.project || options.view
            ? `Current project: ${options.project || 'none'}. Current saved view: ${options.view || 'none'}.\n\n`
            : '';
        const branch = entry.manager.getBranch();
        const parentIndex = turn!.parentEntry
          ? branch.findIndex((item) => item.id === turn!.parentEntry)
          : -1;
        const promptInContext =
          options.retryTurn &&
          branch
            .slice(parentIndex + 1)
            .some((item) => item.type === 'message' && item.message.role === 'user');
        const prompt = promptInContext
          ? 'Continue the previous request. Use the completed tool results already in this conversation; do not repeat completed changes. Finish the response.'
          : context + (options.retryTurn ? turn!.prompt : message);
        if (this.cancelRequested) {
          turn!.status = 'stopped';
          turn!.error = 'Request stopped';
          turn!.errorCode = 'AGENT_REQUEST_STOPPED';
          emit({ type: 'stopped' });
        } else await entry.session.prompt(prompt);
        if (turn!.status === 'working') turn!.status = 'completed';
        const leading = turn!.response.length - turn!.response.trimStart().length;
        turn!.response = turn!.response.trim();
        for (const action of turn!.actions)
          if (action.at !== undefined)
            action.at = Math.min(turn!.response.length, Math.max(0, action.at - leading));
        clearInterval(writeTimer);
        await writeTask;
        await this.tools.db.call('chatUpdate', turn);
        await this.checkpoint(id, entry.manager);
        emit({ type: 'done', text: turn!.response, turn });
      } finally {
        clearTimeout(timeout);
        unsubscribe();
      }
    } catch (error) {
      const failure = this.failure(error);
      if (turn) {
        turn.status = 'failed';
        turn.error = failure.message;
        turn.errorCode = failure.code || '';
        clearInterval(writeTimer);
        await writeTask;
        await this.tools.db.call('chatUpdate', turn);
      }
      throw failure;
    } finally {
      clearInterval(writeTimer);
      this.confirmations.end();
      this.active = undefined;
      this.activeId = undefined;
      this.busy = false;
    }
  }
  async removeConversation(id: string) {
    if (this.activeId === id)
      throw managementError(
        'AGENT_CONVERSATION_BUSY',
        'Stop the active request before changing this conversation.',
      );
    this.sessions.get(id)?.session.dispose();
    this.sessions.delete(id);
    return this.tools.db.call('chatDelete', id);
  }
  async cancel(id: string) {
    if (id !== this.activeId) return { cancelled: false };
    this.cancelRequested = true;
    this.confirmations.pending?.resolve({declined:true,reason:'stopped'});
    await this.active?.abort();
    return { cancelled: true };
  }
  close() {
    for (const entry of this.sessions.values()) entry.session.dispose();
    this.sessions.clear();
  }
}
