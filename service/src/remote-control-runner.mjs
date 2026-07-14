import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { AppServerCodexRunner, AppServerRpcClient } from "./app-server-runner.mjs";
import { RemoteControlController } from "./remote-control-controller.mjs";
import { RemoteControlConnection } from "./remote-control-transport.mjs";

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/**
 * Production composition root for independent Codex Remote Control access.
 *
 * The controller, relay connection, and app-server RPC client are created on
 * first use and then shared for the lifetime of the service. AppServerRpcClient
 * receives only logical Remote Control streams from this runtime.
 */
export class RemoteControlCodexRuntime {
  constructor(options = {}) {
    this.codexHome = options.codexHome || defaultCodexHome();
    this.logger = options.logger || null;
    this.controllerOptions = { ...(options.controllerOptions || {}) };
    this.rpcClientOptions = { ...(options.rpcClientOptions || {}) };
    this.controllerFactory = options.controllerFactory
      || ((controllerOptions) => new RemoteControlController(controllerOptions));
    this.connectionFactory = options.connectionFactory
      || ((connectionOptions) => new RemoteControlConnection(connectionOptions));
    this.rpcClientFactory = options.rpcClientFactory
      || ((clientOptions) => new AppServerRpcClient(clientOptions));
    this.runnerFactory = options.runnerFactory
      || ((runnerOptions) => new AppServerCodexRunner(runnerOptions));
    this.physicalWebSocketFactory = options.webSocketFactory
      || ((url, webSocketOptions) => new WebSocket(url, webSocketOptions));

    this.controller = null;
    this.connection = null;
    this.rpcClient = null;
    this.closed = false;
  }

  createRunner() {
    if (this.closed) throw new Error("Codex Remote Control runtime is closed.");
    const client = this.#sharedRpcClient();
    return this.runnerFactory({ client });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const client = this.rpcClient;
    const connection = this.connection;
    this.rpcClient = null;
    this.connection = null;
    this.controller = null;
    try {
      client?.close?.();
    } finally {
      connection?.terminate?.();
    }
  }

  #sharedController() {
    if (!this.controller) {
      this.controller = this.controllerFactory({
        ...this.controllerOptions,
        codexHome: this.codexHome,
      });
    }
    return this.controller;
  }

  #sharedConnection() {
    if (!this.connection) {
      const controller = this.#sharedController();
      this.connection = this.connectionFactory({
        webSocketFactory: this.physicalWebSocketFactory,
        websocketUrl: controller.websocketUrl,
        getSession: () => controller.refreshSession({ force: true }),
        authorizeDeviceChallenge: (challenge, session) => (
          controller.authorizeDeviceChallenge(challenge, session)
        ),
        logger: this.logger,
      });
    }
    return this.connection;
  }

  #sharedRpcClient() {
    if (!this.rpcClient) {
      const connection = this.#sharedConnection();
      this.rpcClient = this.rpcClientFactory({
        ...this.rpcClientOptions,
        codexHome: this.codexHome,
        // The shared manager owns the physical relay websocket and multiplexes
        // one new logical stream whenever this RPC client reconnects.
        webSocketFactory: () => connection.createStream(),
      });
    }
    return this.rpcClient;
  }
}
