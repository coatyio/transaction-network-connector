/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import {
    CommunicationState,
    Configuration,
    Container,
    MqttBinding,
    MqttBindingOptions,
    ObjectLifecycleController,
    OperatingState,
    Runtime,
} from "@coaty/core";
import { Server, ServerCredentials } from "@grpc/grpc-js";
import Debug from "debug";
import { readFileSync } from "fs";
import * as path from "path";

import { agentInfo } from "../agent.info";
import { TnBaseController } from "../controller/tn-base-controller";
import { TnCommunicationController } from "../controller/tn-communication-controller";
import { TnConsensusController } from "../controller/tn-consensus-controller";
import { TnLifecycleController } from "../controller/tn-lifecycle-controller";
import { RoutingService } from "../service/routing-service";
import { TnBaseService } from "../service/tn-base-service";
import { TnCommunicationService } from "../service/tn-communication-service";
import { TnConsensusService } from "../service/tn-consensus-service";
import { TnLifecycleService } from "../service/tn-lifecycle-service";
import { GrpcPackage } from "./grpc-package";
import { Optional } from "./types";

/**
 * Coaty Communication Options represented as environment variables.
 *
 * For details, see environment file `.env` of this project.
 */
export interface CoatyComEnvOptions {
    coatyAgentIdentityName?: string;
    coatyAgentIdentityId?: string;
    coatyBrokerUrl?: string;
    coatyNamespace?: string;
    coatyUsername?: string;
    coatyPassword?: string;
    coatyTlsCert?: string;
    coatyTlsKey?: string;
    coatyVerifyServerCert?: string;
    coatyFailFastIfOffline?: string;
}

/**
 * Options for TnConnector represented as environment variables.
 *
 * For details, see environment file `.env` of this project.
 */
export interface TnConnectorOptions extends CoatyComEnvOptions {
    debug: Debug.Debugger;

    grpcProtoPath?: string;
    grpcServerPort?: string;

    consensusDatabaseFolder?: string;
}

/**
 * Main class that realizes the FlowPro Transaction Network Connector (TNC)
 * component.
 */
export class TnConnector {

    static readonly IDENTITY_ROLE = "TNC Agent";

    /**
     * A debugger function associated with this TNC instance.
     */
    readonly debug: Debug.Debugger;

    private _options: Required<TnConnectorOptions>;
    private _coatyAgent: Container;
    private _isCoatyAgentOnline: boolean;
    private _grpcPackage: GrpcPackage;
    private _grpcServer: Server;
    private readonly _serviceImpls: Map<string, TnBaseService<TnBaseController>>;

    /**
     * For internal use only. Use static method `start` to start up a new TN
     * Connector.
     */
    private constructor(options: TnConnectorOptions) {
        this._isCoatyAgentOnline = false;
        this.debug = options.debug.extend("TnConnector");
        this._serviceImpls = new Map();
        this._setOptionsWithDefaults(options);
    }

    /**
     * The Coaty agent associated with this TNC instance.
     *
     * @remarks The value will be `undefined` after this TNC instance is
     * stopped.
     */
    get coatyAgent() {
        return this._coatyAgent;
    }

    /**
     * The configuration options as a readonly object with default values filled
     * in for options not specified.
     */
    get options(): Readonly<Required<TnConnectorOptions>> {
        return this._options;
    }

    /**
     * Starts up a new TN Connector with the specified options.
     *
     * @param options TNC specific options read from environment variables (see
     * `.env` file)
     * @returns the started TNC instance
     * @throws if an error occurs on startup
     */
    static async start(options: TnConnectorOptions) {
        const tnc = new TnConnector(options);
        tnc.debug("Starting up with options %j", tnc.options);
        tnc._resolveCoatyAgent(false);
        tnc._createGrpcPackage();
        tnc._createGrpcServer();
        await tnc._startGrpcServer();
        return tnc;
    }

    /**
     * Stops this TN Connector, closing all gRPC and service-specific
     * communication connections.
     *
     * @remarks
     * After stopping, this TNC instance must no longer be used.
     *
     * If the gRPC server is stopped gracefully stopping is delayed until all
     * pending streaming calls are completed by the client or TNC instance. They
     * are not completed by the server. Set parameter gracefully to false to
     * force server to cancel all pending calls immediately.
     *
     * @param gracefully whether to stop the gRPC server gracefully or forcibly.
     * @returns a promise that resolves when the TNC instance has stopped
     */
    async stop(gracefully = true): Promise<void> {
        await Promise.allSettled(Array.from(this._serviceImpls.values()).map(s => s.onStopping()));
        await this._stopGrpcServer(gracefully);
        this._shutdownCoatyAgent();
    }

    /**
     * Restart Coaty agent communication with the given (partial) options.
     *
     * Note that options not specified keep their current value; they are not
     * reset to default values.
     *
     * @param comOptions Coaty communication options
     * @throws if TN Connector has been stopped
     */
    async restartCoatyCommunication(comOptions: CoatyComEnvOptions) {
        if (this.coatyAgent === undefined) {
            throw new Error("TnConnector has been stopped");
        }
        await this.coatyAgent.communicationManager.stop();
        this.debug("TNC agent communication stopped");

        const { coatyAgentIdentityName, coatyAgentIdentityId } = this._options;
        this._setOptionsWithDefaults({
            ...this._options,
            ...comOptions,

            // These options cannot be overridden.
            debug: this.options.debug,
            grpcProtoPath: this.options.grpcProtoPath,
            grpcServerPort: this.options.grpcServerPort,
            consensusDatabaseFolder: this.options.consensusDatabaseFolder,
        });

        // If identity changed, resolve a new Coaty Agent.
        if (this.options.coatyAgentIdentityId !== coatyAgentIdentityId ||
            this.options.coatyAgentIdentityName !== coatyAgentIdentityName) {
            this._shutdownCoatyAgent();
            this._resolveCoatyAgent(true);
        }
        await this.coatyAgent.communicationManager.start({ binding: this._getCoatyComBinding() });
        this.debug("TNC agent communication restarted with options %o", this.options);
    }

    private _setOptionsWithDefaults(options: TnConnectorOptions) {
        const optionalDefaults: Required<Optional<TnConnectorOptions>> = {
            coatyAgentIdentityName: "FlowPro Agent",
            coatyAgentIdentityId: Runtime.newUuid(),
            coatyBrokerUrl: "",
            coatyNamespace: "tnc",
            coatyUsername: "",
            coatyPassword: "",
            coatyTlsCert: "",
            coatyTlsKey: "",
            coatyVerifyServerCert: "true",
            coatyFailFastIfOffline: "true",

            // Use path.join with dirname to ensure pkg tool can access snapshotted proto files.
            grpcProtoPath: path.join(__dirname, "../proto/"),
            grpcServerPort: "50060",

            consensusDatabaseFolder: "",
        };
        this._options = Object.assign(optionalDefaults, options);

        // Read PEM format files if TLS certificate/key options specify file names.
        try {
            if (this._options.coatyTlsCert !== "" && !this._options.coatyTlsCert.startsWith("-----BEGIN CERTIFICATE-----")) {
                this._options.coatyTlsCert = readFileSync(this._options.coatyTlsCert, { encoding: "utf8" });
            }
            if (this._options.coatyTlsKey !== "" && !this._options.coatyTlsKey.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {
                this._options.coatyTlsKey = readFileSync(this._options.coatyTlsKey, { encoding: "utf8" });
            }
        } catch (error) {
            this.debug("Couldn't read Coaty TLS certificate or private key file: %s", error.message);
        }
    }

    private _resolveCoatyAgent(suppressAutoStart: boolean) {
        const comps = {
            controllers: {
                ObjectLifecycleController,
                TnCommunicationController,
                TnLifecycleController,
                TnConsensusController,
            },
        };
        const controllerConfig = {
            TnCommunicationController: {
            },
            TnLifecycleController: {
            },
            TnConsensusController: {
            },
        };
        const config: Configuration = {
            common: {
                agentInfo,
                agentIdentity: {
                    name: this.options.coatyAgentIdentityName,
                    objectId: this.options.coatyAgentIdentityId,
                },
                extra: this.options,
            },
            communication: {
                binding: this._getCoatyComBinding(),
                shouldAutoStart: !suppressAutoStart && !!this.options.coatyBrokerUrl,
            },
            controllers: controllerConfig,
            databases: {
                raftStore: {
                    adapter: "SqLiteNodeAdapter",
                    connectionString: path.join(this.options.consensusDatabaseFolder, `flowpro-tnc-raft-${this.options.coatyAgentIdentityId}.db`),
                },
            },
        };

        // Make TNC agents discoverable by TnLifecycleController.
        config.common.agentIdentity["role"] = TnConnector.IDENTITY_ROLE;

        const container = Container.resolve(comps, config);

        this.debug("TNC agent resolved with identity %o", container.identity);

        container.communicationManager.observeCommunicationState()
            .subscribe(state => {
                if (container.communicationManager === undefined) {
                    // Container already shut down.
                    this._isCoatyAgentOnline = false;
                    return;
                }
                this._isCoatyAgentOnline = state === CommunicationState.Online;
                const comOptions = container.communicationManager.options.binding.options as MqttBindingOptions;
                this.debug("TNC agent communication state: %s on namespace '%s' at %s",
                    this._isCoatyAgentOnline ? "online" : "offline",
                    comOptions.namespace,
                    comOptions.brokerUrl || "not yet specified broker URL");
            });

        container.communicationManager.observeOperatingState()
            .subscribe(opState => {
                this.debug("TNC agent operating state: %s", opState === OperatingState.Started ? "started" : "stopped");
            });

        this._coatyAgent = container;
    }

    private _shutdownCoatyAgent() {
        const agent = this.coatyAgent;
        if (agent !== undefined) {
            this._coatyAgent = undefined;
            this._isCoatyAgentOnline = false;
            this.debug("Shutting down Coaty agent '%s' with identity %s", agent.identity.name, agent.identity.objectId);
            agent.shutdown();
        }
    }

    private _getCoatyComBinding() {
        const bindingOptions: MqttBindingOptions = {
            namespace: this.options.coatyNamespace,
            brokerUrl: this.options.coatyBrokerUrl,
        };
        if (this.options.coatyUsername) {
            bindingOptions.username = this.options.coatyUsername;
        }
        if (this.options.coatyPassword) {
            bindingOptions.password = this.options.coatyPassword;
        }
        if (this.options.coatyTlsCert && this.options.coatyTlsKey) {
            bindingOptions.tlsOptions = {
                cert: this.options.coatyTlsCert,
                key: this.options.coatyTlsKey,
            };
            if (this.options.coatyVerifyServerCert === "false") {
                bindingOptions.tlsOptions.rejectUnauthorized = false;
            }
        }
        if ((bindingOptions.brokerUrl.startsWith("wss")
            || bindingOptions.brokerUrl.startsWith("wxs")
            || bindingOptions.brokerUrl.startsWith("alis"))
            && this.options.coatyVerifyServerCert === "false") {
            bindingOptions.wsOptions = {
                rejectUnauthorized: false,
            };
        }
        return MqttBinding.withOptions(bindingOptions);
    }

    private _createGrpcPackage() {
        const protos = ["tnc_coaty.proto", "tnc_icc.proto", "tnc_life.proto", "tnc_consensus.proto"];
        this._grpcPackage = new GrpcPackage(protos.map(p => path.join(this.options.grpcProtoPath, p)));
        this.debug("Loaded gRPC protobuf definitions from %s", protos.join(", "));
    }

    private _createGrpcServer() {
        const server = new Server();
        this._addServiceImpl(server, "flowpro.tnc.icc.RoutingService",
            new RoutingService(this.debug));
        this._addServiceImpl(server, "flowpro.tnc.coaty.CommunicationService",
            new TnCommunicationService(
                () => this.coatyAgent.getController<TnCommunicationController>("TnCommunicationController"),
                () => this.options,
                () => this._isCoatyAgentOnline,
                this.debug,
                opts => this.restartCoatyCommunication(opts),
            ));
        this._addServiceImpl(server, "flowpro.tnc.life.LifecycleService",
            new TnLifecycleService(
                () => this.coatyAgent.getController<TnLifecycleController>("TnLifecycleController"),
                () => this.options,
                () => this._isCoatyAgentOnline,
                this.debug,
            ));
        this._addServiceImpl(server, "flowpro.tnc.consensus.ConsensusService",
            new TnConsensusService(
                () => this.coatyAgent.getController<TnConsensusController>("TnConsensusController"),
                () => this.options,
                () => this._isCoatyAgentOnline,
                this.debug,
            ));
        this._grpcServer = server;
    }

    private _addServiceImpl(server: Server, serviceName: string, impl: TnBaseService<TnBaseController>) {
        this._serviceImpls.set(serviceName, impl);
        server.addService(this._grpcPackage.getServiceDefinition(serviceName), impl.handlers);
    }

    private async _startGrpcServer() {
        return new Promise<void>((resolve, reject) => {
            const server = this._grpcServer;
            if (!server) {
                reject(new Error("gRPC server not yet created"));
                return;
            }
            server.bindAsync("0.0.0.0:" + this.options.grpcServerPort,
                ServerCredentials.createInsecure(),
                (error, port) => {
                    if (error) {
                        reject(new Error(`grpc Server port ${this.options.grpcServerPort} could not be bound. Is port already in use or blocked by firewall? Original error: ${error.message}`));
                        return;
                    }
                    server.start();
                    this.debug("Started gRPC server on port %d", port);
                    resolve();
                });
        });
    }

    private async _stopGrpcServer(gracefully: boolean) {
        return new Promise<void>(resolve => {
            const server = this._grpcServer;
            if (server !== undefined) {
                this._grpcServer = undefined;

                if (gracefully) {
                    // Gracefully shuts down the server. The server will stop receiving
                    // new calls, and any pending calls will complete. The callback will
                    // be called when all pending calls have completed and the server is
                    // fully shut down.
                    server.tryShutdown(() => {
                        this.debug("Stopped gRPC server");
                        resolve();
                    });
                } else {
                    server.forceShutdown();
                    resolve();
                }
            } else {
                resolve();
            }
        });
    }
}
