# Inter-Agent Communication Patterns: Survey & Recommendations for Tower

> Research conducted for Tower's inter-session communication design.
> Tower is a long-running daemon where multiple Copilot agent sessions run simultaneously with persistent workspaces.

---

## Table of Contents

1. [Comparison Table](#comparison-table)
2. [CrewAI](#1-crewai)
3. [LangGraph](#2-langgraph-langchain)
4. [AutoGen](#3-autogen-microsoft)
5. [OpenAI Swarm](#4-openai-swarm)
6. [Anthropic Patterns](#5-anthropic-multi-agent-patterns)
7. [Copilot CLI Sub-Agents](#6-copilot-cli-sub-agent-system)
8. [Google A2A Protocol](#7-google-a2a-protocol)
9. [Recommendations for Tower](#recommendations-for-tower)
10. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)

---

## Comparison Table

| Dimension | CrewAI | LangGraph | AutoGen v0.4 | Swarm | Anthropic | Copilot CLI | Google A2A |
|---|---|---|---|---|---|---|---|
| **Agent→Agent send** | `DelegateWorkTool` (LLM tool call) | Shared state graph edges | `send_message()` (direct) / `publish_message()` (pub/sub) | Return `Agent` from tool fn | Orchestrator calls worker prompts | `task` tool spawns subprocess | `POST /message:send` (JSON-RPC) |
| **Result return** | Synchronous string return from tool | State dict merged via reducers | `send_message` returns response future; `publish` is fire-and-forget | Sync return in run loop | Sync return from LLM call | Blocking (task) or poll via `read_agent` (background) | Poll `GET /tasks/{id}`, SSE stream, or push notification |
| **Discovery** | Agents listed in Crew constructor | Nodes declared in graph builder | `TypeSubscription` routing + runtime registry | Explicit handoff functions | Hardcoded in orchestrator prompt | Agent types hardcoded in tool schema | Agent Card at `/.well-known/agent-card.json` |
| **Shared state** | Crew-scoped `Memory` (embeddings-backed) | `TypedDict` state with reducer annotations | No built-in; use external stores | `context_variables` dict | No shared state; context passed in prompts | No shared state between agents | `Task.history` + `context_id` grouping |
| **Spawn sub-agents** | Hierarchical process spawns manager | `Send()` fans out to dynamic nodes | Teams can nest other teams as participants | No dynamic spawn; static agent graph | Orchestrator spawns N workers | `task` tool creates subprocess agents | Client creates new tasks on remote agents |
| **Orchestration** | Sequential or Hierarchical (enum) | Arbitrary DAG with conditional edges | GroupChat with speaker selection (round-robin, selector, swarm) | Linear handoff chain | Sequential chain, parallel fan-out, routing | Blocking sequential or parallel background agents | Client-driven; no built-in orchestration |
| **Async support** | `Task.async_execution` + `akickoff()` | Native async; `ainvoke()`, `astream()` | Fully async runtime (`asyncio`) | Sync only (educational) | ThreadPoolExecutor for parallel | Background agents via `read_agent`/`write_agent` | SSE streaming + webhook push notifications |
| **Persistence** | Memory persisted to embeddings store | Checkpointer (InMemory, SQLite, Postgres) | No built-in | None | None | Session store (DuckDB) for history | Task state persisted server-side |

---

## 1. CrewAI

### Architecture: Crew → Agent → Task

```
Crew(agents=[a1, a2], tasks=[t1, t2], process=Process.sequential)
```

A `Crew` owns a list of `Agent`s and `Task`s. Tasks execute in order (sequential) or are dispatched by a manager agent (hierarchical).

### How Agent A delegates to Agent B

Delegation happens through **LLM tool calls**, not direct API invocation. When `Agent.allow_delegation=True`, the agent receives two tools:

- **`DelegateWorkTool`** — schema: `{task, context, coworker}` → creates a new `Task`, finds the coworker agent by name, calls `agent.execute_task()`
- **`AskQuestionTool`** — same mechanism but framed as a question

```python
# Under the hood (base_agent_tools.py):
def _execute(self, task, context, coworker):
    agent = self._get_coworker(coworker)  # name lookup
    delegated_task = Task(description=task, agent=agent, expected_output="...")
    return agent.execute_task(delegated_task, context)  # synchronous
```

**Key insight**: The delegating agent's LLM decides *when* and *to whom* to delegate. The framework resolves the coworker by name string matching against the crew's agent list. Results return synchronously as a string into the calling agent's tool output.

### Task handoff / context flow

```python
t1 = Task(description="Research topic X", agent=researcher)
t2 = Task(description="Write report", agent=writer, context=[t1])  # explicit dependency
```

- If `task.context` is set explicitly, those specific task outputs are passed.
- If `task.context` is not set (default), **all prior task outputs** are aggregated as context.
- `TaskOutput` contains: `raw` (string), `pydantic` (typed model), `json_dict`, `agent` (who produced it).

### Async / parallel execution

```python
t1 = Task(description="...", async_execution=True)  # runs in background
t2 = Task(description="...", async_execution=True)
t3 = Task(description="...", context=[t1, t2])       # waits for both
```

- `async_execution=True` spawns the task in a thread (sync mode) or `asyncio.create_task` (async mode).
- Validation: the last task in a sequential crew cannot be async; async tasks can't depend on future async tasks.
- `akickoff()` is the native async entry point.

### Memory / context sharing

```python
crew = Crew(agents=[...], tasks=[...], memory=True)  # enables crew-scoped memory
```

- Memory is scoped to `/crew/<crew_name>` and backed by an embeddings store.
- `Memory`, `MemoryScope`, `MemorySlice` are the public API.
- Agents automatically `recall(task.description, limit=5)` from memory before executing.
- Legacy names (`LongTermMemory`, `ShortTermMemory`, `EntityMemory`) have been unified into a single `Memory` class.

### Relevance to Tower

CrewAI's model is **tightly coupled** — agents exist within a single Crew process and delegate via tool calls within the same LLM context. Not directly applicable to Tower's independent session model, but the "delegation as a tool" pattern is reusable.

---

## 2. LangGraph (LangChain)

### Architecture: StateGraph with typed state

```python
class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]
    next_agent: str

builder = StateGraph(State)
builder.add_node("researcher", researcher_node)
builder.add_node("writer", writer_node)
builder.add_conditional_edges("router", route_fn, {"research": "researcher", "write": "writer"})
graph = builder.compile(checkpointer=InMemorySaver())
```

### How nodes communicate

**Through shared state, not direct messaging.** Each node:
1. Receives the full state dict
2. Returns a partial update `{"key": new_value}`
3. Updates merge via **reducer functions** (e.g., `add_messages` appends to list)

```python
def researcher_node(state: State) -> dict:
    result = llm.invoke(state["messages"])
    return {"messages": [result]}  # merged via add_messages reducer
```

### Send API (fan-out)

```python
def route(state):
    return [Send("worker", {"subject": s}) for s in state["subjects"]]

builder.add_conditional_edges(START, route)
```

`Send(node_name, arg)` invokes a node with **custom input state** — enables map-reduce / fan-out patterns.

### Command API (imperative control flow)

```python
def node(state):
    return Command(
        update={"messages": [AIMessage("done")]},
        goto=["next_node"],  # or Send objects
    )
```

`Command` combines state updates with navigation, including cross-subgraph jumps via `graph=Command.PARENT`.

### Conditional routing

```python
def route_fn(state: State) -> str:
    if state["next_agent"] == "research":
        return "researcher"
    return "writer"

builder.add_conditional_edges("router", route_fn, {"researcher": "researcher", "writer": "writer"})
```

### Checkpointing / persistence

```python
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.sqlite import SqliteSaver

graph = builder.compile(checkpointer=InMemorySaver())
# or
graph = builder.compile(checkpointer=SqliteSaver.from_conn_string("checkpoints.sqlite"))
```

State is checkpointed after every node execution. Enables:
- Resume from any point
- Human-in-the-loop via `interrupt()` / `Command(resume=...)`
- Time-travel debugging

### Subgraphs

```python
subgraph = sub_builder.compile()
parent.add_node("sub", subgraph)  # CompiledGraph is a runnable node
```

Subgraphs inherit parent checkpointers and can communicate via shared state keys.

### Relevance to Tower

LangGraph's **state-as-communication-channel** pattern is highly relevant. Tower sessions could share a typed state object (or subset thereof) that acts as the communication medium. The checkpointing model maps well to Tower's persistent session model.

---

## 3. AutoGen (Microsoft)

### v0.2 (Legacy): Direct message passing

```python
# Agent A sends to Agent B
agent_a.send(message="Please analyze this data", recipient=agent_b)

# Under the hood:
# 1. A appends message to its chat history
# 2. A calls B.receive(message, sender=A)
# 3. B generates a reply
# 4. B calls A.receive(reply, sender=B)
# Loop continues until termination
```

Termination: `is_termination_msg` predicate (default: content == `"TERMINATE"`) or `max_consecutive_auto_reply` counter.

### v0.2 GroupChat

```python
group_chat = GroupChat(
    agents=[agent_a, agent_b, agent_c],
    messages=[],
    max_round=10,
    speaker_selection_method="auto",  # auto|manual|random|round_robin
)
manager = GroupChatManager(groupchat=group_chat)
agent_a.initiate_chat(manager, message="Let's solve this problem")
```

- `GroupChatManager` broadcasts each message to all agents
- Selects next speaker via LLM (auto), random, or round-robin
- All agents see all messages (shared conversation)

### v0.4 (Current): Runtime + Pub/Sub

Completely redesigned around an async runtime with typed messaging:

```python
# Direct messaging (request/response)
result = await agent.send_message(
    MyRequest(data="..."),
    recipient=AgentId("analyzer", "instance1"),
)

# Pub/sub (fire and forget)
await agent.publish_message(
    StatusUpdate(status="done"),
    topic_id=TopicId("updates", "project1"),
)
```

**Key difference**: `send_message` returns a future (the recipient's response). `publish_message` is fire-and-forget.

### v0.4 Subscription / routing

```python
TypeSubscription(topic_type="tasks", agent_type="worker")
TypePrefixSubscription(topic_type_prefix="project:", agent_type="analyzer")
DefaultSubscription()  # receives all
```

Agents auto-register direct-message subscriptions on `register_instance()`.

### v0.4 GroupChat

- `BaseGroupChatManager` orchestrates: receives `GroupChatStart`, selects speaker, publishes to participant topics
- Speaker selection: round-robin, LLM-based selector, or swarm-style (follow `HandoffMessage.target`)
- **Nested teams**: a `Team` can participate in a `GroupChat`, publishing its `TaskResult.messages` to the parent

### Relevance to Tower

AutoGen v0.4's **dual-mode messaging** (direct request/response + pub/sub broadcast) is the closest match to what Tower needs. The runtime's subscription-based routing could map to Tower's session registry.

---

## 4. OpenAI Swarm

### Architecture: Minimal, educational framework

```python
agent_a = Agent(
    name="Triage",
    instructions="Route customer requests...",
    functions=[transfer_to_billing, transfer_to_support],
)

def transfer_to_billing():
    return billing_agent  # returning an Agent triggers handoff

response = client.run(agent=agent_a, messages=[...])
# response.agent = billing_agent (if handoff occurred)
# response.context_variables = merged context
```

### Handoff mechanism

A handoff is simply a **tool function that returns an `Agent` object**:

```python
def transfer_to_support():
    """Transfer to support agent"""
    return support_agent

# Or with context updates:
def transfer_to_billing(context_variables):
    context_variables["department"] = "billing"
    return Result(value="Transferring...", agent=billing_agent, context_variables=context_variables)
```

Under the hood (`core.py`):
1. `handle_function_result()` detects if return value is an `Agent` or `Result(agent=...)`
2. `Swarm.run()` loop updates `active_agent` to the returned agent
3. Next iteration uses the new agent's instructions and tools
4. `context_variables` persist across handoffs

### Context transfer

- `context_variables` is a mutable dict passed to all tool functions and string-interpolated into agent instructions
- On handoff, the new agent inherits the full `context_variables` + conversation history

### Sync only

`Swarm.run()` is a blocking loop. `run_and_stream()` provides token-level streaming but is still fundamentally synchronous.

### Relevance to Tower

Swarm's **handoff-as-return-value** pattern is elegant for its simplicity. For Tower, the analog would be: a session's tool call returns a "delegate to session X" instruction that the gateway interprets. Simple, stateless, no complex routing.

---

## 5. Anthropic Multi-Agent Patterns

### Published patterns (from claude-cookbooks)

Anthropic documents five workflow patterns, not a framework:

#### 1. Prompt Chaining
```python
def chain(input, prompts):
    for prompt in prompts:
        input = llm.invoke(prompt + input)
    return input
```

#### 2. Routing
```python
def route(input, routes):
    category = llm.classify(input, categories=routes.keys())
    return llm.invoke(routes[category] + input)
```

#### 3. Parallelization
```python
def parallel(prompt, inputs, n_workers=3):
    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        return list(pool.map(lambda i: llm.invoke(prompt + i), inputs))
```

#### 4. Orchestrator-Workers
```python
class FlexibleOrchestrator:
    def process(self, task, context=None):
        # 1. Orchestrator LLM call decomposes task into subtasks (XML format)
        analysis = llm.invoke(self.orchestrator_prompt + task)
        subtasks = parse_xml(analysis)  # <analysis> + <tasks>

        # 2. Each subtask dispatched to worker (sequentially, N+1 calls)
        results = []
        for subtask in subtasks:
            result = llm.invoke(self.worker_prompt + subtask)
            results.append(result)

        # 3. Orchestrator synthesizes
        return llm.invoke(synthesis_prompt + results)
```

#### 5. Evaluator-Optimizer
Loop: generator produces output → evaluator scores it → loop until quality threshold met.

### Key insight

Anthropic explicitly recommends **not** building complex agent frameworks. Their position: use simple code patterns (loops, if/else, function calls) rather than framework abstractions. The patterns above are plain Python with no special runtime.

### Relevance to Tower

The orchestrator-workers pattern maps directly to Tower's router + sessions model. The router decomposes and delegates; sessions are the workers. Anthropic's "keep it simple" philosophy is worth heeding.

---

## 6. Copilot CLI Sub-Agent System

### The `task` tool

From the Copilot CLI's tool schema (verified from documentation):

```
task(name, prompt, agent_type, description, model?)
```

Agent types: `explore`, `task`, `general-purpose`, `code-review`, `configure-copilot`, plus custom agents.

- **`explore`**: Read-only codebase research (Haiku model, grep/glob/view/bash)
- **`task`**: Command execution, returns brief summary on success, full output on failure
- **`general-purpose`**: Full capability subprocess (Sonnet model, all tools)
- **`code-review`**: Analyzes diffs, read-only

### How it works

1. Parent agent calls `task` tool with a prompt and agent type
2. System spawns a **separate context window** (subprocess) with its own conversation
3. Agent executes autonomously with its allocated toolset
4. Results return as a single message to the parent

### Blocking vs Background

- **Default (no mode specified)**: Blocking — parent waits for result
- **`mode: "background"`**: Non-blocking — returns an `agent_id` immediately

```
# Background agent lifecycle:
task(mode="background") → agent_id
read_agent(agent_id, wait=true/false, timeout=60) → status + results
write_agent(agent_id, message) → sends follow-up turn to idle agent
list_agents() → shows all active/completed agents
```

### Communication model

- **One-way prompt**: Parent sends complete context in the prompt (agents are stateless)
- **No shared memory**: Each agent has its own context window
- **No agent-to-agent**: Sub-agents cannot communicate with each other, only with their parent
- **Multi-turn for background agents**: `write_agent` enables ongoing conversation

### Relevance to Tower

This is the closest existing system to what Tower needs. Key differences from what Tower wants:
- CLI sub-agents are ephemeral (no persistence)
- No inter-agent communication (only parent↔child)
- No shared state between agents
- Discovery is hardcoded (agent types in tool schema)

---

## 7. Google A2A (Agent-to-Agent) Protocol

### What it is

An **open protocol** for agent-to-agent communication over HTTP. Think REST API but specifically designed for AI agent interoperability across organizations and platforms.

### Agent discovery

```json
// GET https://agent.example.com/.well-known/agent-card.json
{
  "name": "Research Agent",
  "description": "Performs deep research on topics",
  "url": "https://agent.example.com",
  "capabilities": { "streaming": true, "pushNotifications": true },
  "skills": [
    { "id": "research", "name": "Deep Research", "description": "..." }
  ],
  "security_schemes": { "oauth2": { ... } }
}
```

### Core API (JSON-RPC over HTTP)

| Method | Path | Purpose |
|--------|------|---------|
| `SendMessage` | `POST /message:send` | Send task to agent, get sync response |
| `SendStreamingMessage` | `POST /message:stream` | Send task, get SSE stream of updates |
| `GetTask` | `GET /tasks/{id}` | Poll task status |
| `SubscribeToTask` | `GET /tasks/{id}:subscribe` | SSE subscription for task updates |
| `GetExtendedAgentCard` | `GET /extendedAgentCard` | Post-auth capabilities |

### Task lifecycle

```
SUBMITTED → WORKING → COMPLETED
                   → FAILED
                   → CANCELED
         → INPUT_REQUIRED (human-in-the-loop)
         → AUTH_REQUIRED
         → REJECTED
```

A `Task` carries: `id`, `context_id` (groups related tasks), `status`, `artifacts` (outputs), `history` (message log).

### Async communication modes

1. **Synchronous**: `SendMessage` returns completed task
2. **Streaming**: `SendStreamingMessage` returns SSE events with `status_update` and `artifact_update`
3. **Polling**: `GetTask` to check status
4. **Push notifications**: Register webhook via `CreateTaskPushNotificationConfig`

### A2A vs MCP

| | A2A | MCP |
|---|---|---|
| **Purpose** | Agent-to-agent collaboration | Agent-to-tool access |
| **Relationship** | Peer-to-peer | Client-server |
| **Communication** | Task-based, opaque execution | Tool calls, structured I/O |
| **Discovery** | Agent Cards | Tool/resource manifests |
| **Complementary** | Yes — an A2A agent can use MCP tools internally |

### Relevance to Tower

A2A is the **most directly applicable** protocol for Tower's needs. Tower sessions are essentially agents that could expose Agent Cards, accept tasks via a gateway-mediated API, and report results through the task lifecycle model. The protocol handles all of Tower's requirements: discovery, async, streaming, multi-turn.

---

## Recommendations for Tower

### Pattern 1: Task-Based Inter-Session Communication (Primary)

**Adopt A2A's task lifecycle model, implemented internally via the gateway.**

```
Session A                    Gateway                     Session B
    |                           |                           |
    |-- session.delegate ------>|                           |
    |   {target, task, context} |-- session.send ---------> |
    |                           |   (creates task record)   |
    |                           |                           |
    |<-- task.status_update ----|<-- event (tool results) --|
    |   {task_id, WORKING}      |                           |
    |                           |                           |
    |<-- task.completed --------|<-- session completes -----|
    |   {task_id, artifacts}    |                           |
```

**Why**: Tower's gateway already manages session lifecycle and broadcasts events. Adding a task registry is a natural extension. Sessions don't need to know about each other's internals — the gateway mediates.

**Implementation sketch**:
```typescript
// New protocol messages
type SessionDelegate = {
  type: "session.delegate";
  taskId: string;
  target: string | { capabilities: string[] };  // session ID or capability query
  task: string;          // natural language task description
  context?: unknown;     // structured context to pass
  mode: "blocking" | "background";
};

type TaskStatusUpdate = {
  type: "task.status";
  taskId: string;
  status: "submitted" | "working" | "completed" | "failed" | "input_required";
  result?: unknown;
};
```

### Pattern 2: Shared State via Gateway (Secondary)

**Adopt LangGraph's typed-state-with-reducers pattern for cross-session shared context.**

```typescript
// Gateway maintains a shared state store per "workspace" or "project"
interface SharedState {
  findings: Annotated<Finding[], append>;     // append-only
  decisions: Annotated<Decision[], append>;
  activeGoal: string;                          // last-write-wins
}

// Sessions read/write via protocol messages
type StateRead = { type: "state.read"; keys: string[] };
type StateWrite = { type: "state.write"; updates: Partial<SharedState> };
type StateSubscribe = { type: "state.subscribe"; keys: string[] };
```

**Why**: Multiple sessions working on the same project need to share findings without sending full context back and forth. The reducer pattern (from LangGraph) prevents conflicts in append-only data.

### Pattern 3: Session Discovery via Router Enhancement

**Extend the existing router to serve as a discovery/capability registry.**

```typescript
// Sessions register capabilities on creation
type SessionCapabilities = {
  sessionId: string;
  name: string;
  skills: string[];           // e.g., ["code-review", "testing", "research"]
  status: "idle" | "busy";
  currentTask?: string;
};

// Delegation can target capabilities instead of specific sessions
{ target: { capabilities: ["code-review"] } }
// Gateway/router resolves to best available session
```

**Why**: Tower's router already selects sessions for incoming queries. Extending it with capability-based routing enables sessions to delegate to "whoever can do X" rather than hardcoding session IDs.

### Pattern 4: Multi-Turn Delegation (from Copilot CLI)

**Support ongoing conversation between sessions, not just fire-and-forget.**

```
Session A: delegate("Session B", "Review this PR")
Session B: working...
Session B: input_required("Should I also check test coverage?")
Session A: reply(task_id, "Yes, include coverage analysis")
Session B: working...
Session B: completed({review: "...", coverage: "..."})
```

**Why**: The Copilot CLI's `write_agent`/`read_agent` pattern proves that multi-turn delegation is valuable. A2A's `INPUT_REQUIRED` state handles this elegantly.

### Summary: What to build

| Priority | Pattern | Inspiration | Complexity |
|----------|---------|-------------|------------|
| **P0** | Task delegation with lifecycle tracking | A2A + Copilot CLI `task` tool | Medium |
| **P1** | Gateway-mediated routing (capability-based) | AutoGen v0.4 subscriptions + existing router | Medium |
| **P1** | Status/result streaming to delegating session | A2A SSE + existing event broadcast | Low (extends existing) |
| **P2** | Shared state store with reducers | LangGraph state pattern | Medium-High |
| **P2** | Multi-turn delegation (input_required flow) | A2A + Copilot CLI `write_agent` | Medium |
| **P3** | Session-to-session pub/sub for broadcasts | AutoGen v0.4 `publish_message` | Low |

---

## Anti-Patterns to Avoid

### 1. ❌ Direct session-to-session communication
**Every framework** that scales puts a mediator between agents. CrewAI uses the Crew, AutoGen uses the Runtime, A2A uses HTTP. Don't let sessions talk directly — always go through the gateway. This ensures:
- Lifecycle management (what if the target session is dead?)
- Audit logging
- Permission control
- Load balancing

### 2. ❌ Shared mutable state without reducers
LangGraph's reducer pattern exists for a reason. If two sessions write to the same state key simultaneously, you get race conditions. Either use append-only reducers or last-write-wins with conflict detection.

### 3. ❌ Unbounded delegation chains
CrewAI and Swarm both suffer from this: Agent A delegates to B, who delegates to C, who delegates to D... Set a maximum delegation depth. AutoGen's `max_consecutive_auto_reply` is the right idea.

### 4. ❌ Passing full conversation history between sessions
Swarm passes the entire message history on handoff. This explodes context windows. Instead:
- Pass a **structured summary** or **specific artifacts**
- Let the receiving session request more context if needed
- Use shared state for large persistent context

### 5. ❌ LLM-based routing for deterministic decisions
CrewAI and AutoGen both use LLM calls to select the next agent. This is slow, expensive, and non-deterministic. For Tower:
- Use deterministic routing (capability matching, round-robin) for delegation
- Reserve LLM routing for ambiguous user queries (which the router already handles)

### 6. ❌ Building a framework when you need a protocol
Anthropic's advice is sound: don't build CrewAI. Tower's sessions are already independent agents. What's needed is a **communication protocol** (like A2A), not an orchestration framework. The gateway is the only orchestrator needed.

### 7. ❌ Synchronous-only delegation
Every system that started sync-only (Swarm, CrewAI) eventually added async. Build async-first with `mode: "blocking" | "background"`, since Tower sessions are inherently long-running. Blocking mode is just `background + await`.

### 8. ❌ No timeout/cancellation on delegated tasks
A2A includes `CANCELED` state. AutoGen has `cancellation_token`. Every delegated task needs a timeout and a way to cancel. Without this, one stuck session blocks its delegator forever.

---

## Appendix: Tower's Current Architecture (for context)

Tower today has:
- **Gateway**: WebSocket + HTTP server managing session lifecycle
- **Sessions**: Copilot SDK instances with persistent workspaces
- **Router**: Always-on session that routes incoming queries to appropriate sessions
- **Protocol**: JSON frames over WebSocket (create/resume/send/list/etc.)
- **Event broadcast**: Gateway fans out session events to all attached WS subscribers
- **Permission broadcast**: Cross-client permission prompt resolution

What's **missing** for inter-session communication:
- No `session.delegate` message type
- No task registry / lifecycle tracking
- No capability-based session discovery
- No shared state between sessions
- No way for a session to reference or wait on another session's work
