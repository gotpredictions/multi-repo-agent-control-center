// Shared newline-delimited JSON RPC framing over a single local transport
// (a Unix domain socket path — on Windows the same string doubles as a
// named pipe path, e.g. \\.\pipe\..., which node's net module already
// handles transparently via the same net.createServer/net.createConnection
// calls). One implementation, used by everyone who used to speak a
// slightly different ad hoc protocol: the daemon (server.ts, the listening
// side) and every client of it (extension.ts's RunnerClient, mcpServer.ts).
//
// Framing is unchanged from the old stdio protocol this replaces:
// requests are `{id, cmd, ...params}\n`, replies are `{id, ok, data|error}\n`,
// and the server can also push unsolicited `{event, ...}\n` lines (e.g.
// `{event:"update", dbId}`) to every connected client.
import * as net from "node:net";
import * as fs from "node:fs";
import * as readline from "node:readline";

export type IpcRequest = { id: number; cmd: string; [k: string]: any };

export class IpcServer {
  private server: net.Server;
  private sockets = new Set<net.Socket>();

  constructor(socketPath: string, private handle: (req: IpcRequest) => unknown | Promise<unknown>) {
    // A stale socket file (daemon killed without a clean SIGTERM) makes
    // listen() fail with EADDRINUSE even though nothing is actually
    // listening on it anymore — remove it first. If something else really
    // is still bound there, listen() below fails for real and the caller
    // finds out from that, not from a misleading stale-file error.
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // fine if it didn't exist
    }
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.listen(socketPath);
  }

  private onConnection(socket: net.Socket) {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {
      // A client going away mid-write shouldn't take the daemon down —
      // the next broadcast just stops reaching this (now-removed) socket.
    });
    const rl = readline.createInterface({ input: socket });
    // node's readline.Interface listens to `input`'s own 'error' event
    // internally and RE-EMITS it on itself (a separate EventEmitter from
    // the socket) — the socket.on("error", ...) above only silences the
    // first emission. An 'error' event with zero listeners is the one
    // case Node always crashes the process over, confirmed live: a
    // client disconnecting mid-broadcast (EPIPE on socket.write) took the
    // whole daemon down through exactly this path, not the socket's own
    // 'error' handler (which fired fine and did nothing, as intended).
    rl.on("error", () => {});
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let req: IpcRequest;
      try {
        req = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const data = await this.handle(req);
        this.send(socket, { id: req.id, ok: true, data });
      } catch (err: any) {
        this.send(socket, { id: req.id, ok: false, error: err?.message ?? String(err) });
      }
    });
  }

  private send(socket: net.Socket, obj: unknown) {
    // Checked, not just try/caught: a failing write on an already-dead
    // socket surfaces as an async 'error' event, not a synchronous throw
    // — try/catch here never actually catches it (see the rl.on("error")
    // comment above for how that previously crashed the whole daemon).
    // This check just avoids attempting the doomed write in the first
    // place for the common case (socket already closed).
    if (socket.destroyed || !socket.writable) return;
    try {
      socket.write(JSON.stringify(obj) + "\n");
    } catch {
      // fine — the rl.on("error", () => {}) / socket.on("error", () => {})
      // handlers are what actually matter for the async case.
    }
  }

  broadcast(event: Record<string, unknown>) {
    for (const s of this.sockets) this.send(s, event);
  }

  close() {
    this.server.close();
    for (const s of this.sockets) s.destroy();
  }
}

export class IpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private updateListeners: Array<(event: Record<string, any>) => void> = [];
  readonly ready: Promise<void> = Promise.resolve();

  private constructor(private socket: net.Socket) {
    const rl = readline.createInterface({ input: socket });
    // Same reasoning as IpcServer's rl.on("error", ...) — readline.Interface
    // re-emits the input stream's own 'error' on itself, unguarded that's
    // an unhandled-error crash regardless of any listener on the socket.
    rl.on("error", () => {});
    socket.on("error", () => {
      // The daemon dying (or this connection otherwise breaking) surfaces
      // here — the "close" handler just below already rejects every
      // pending call, so there's nothing further to do but not crash.
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.event) {
        for (const l of this.updateListeners) l(msg);
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new Error(msg.error));
    });
    socket.on("close", () => {
      for (const p of this.pending.values()) p.reject(new Error("daemon connection closed"));
      this.pending.clear();
    });
  }

  // Retries because the daemon may still be coming up — just spawned by
  // the extension, or replacing a stale socket file left by a crashed
  // previous instance — and a single connect() racing that would fail
  // permanently on the very first attempt instead of waiting it out.
  static async connect(socketPath: string, opts: { retries?: number; delayMs?: number } = {}): Promise<IpcClient> {
    const retries = opts.retries ?? 25;
    const delayMs = opts.delayMs ?? 200;
    let lastErr: any;
    for (let i = 0; i < retries; i++) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(socketPath);
          s.once("connect", () => resolve(s));
          s.once("error", reject);
        });
        return new IpcClient(socket);
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw new Error(`could not connect to the control center daemon at ${socketPath}: ${lastErr?.message ?? lastErr}`);
  }

  onUpdate(cb: (event: Record<string, any>) => void) {
    this.updateListeners.push(cb);
  }

  call(cmd: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // params spread FIRST — id/cmd must win if a param happens to be
      // named either (e.g. upsert_task's own "id" field), or the RPC
      // envelope's own message id gets silently clobbered, breaking
      // response correlation for that call.
      this.socket.write(JSON.stringify({ ...params, id, cmd }) + "\n");
    });
  }

  dispose() {
    this.socket.end();
  }
}
