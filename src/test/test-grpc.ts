/*! Copyright (c) 2023 Siemens AG. Licensed under the MIT License. */

import { Client, credentials } from "@grpc/grpc-js";
import * as path from "path";
import * as tp from "tap";

import { GrpcPackage } from "../common/grpc-package";
import { testTnConnectorOptions } from "./test-context";

export interface GrpcTestClientWithPackage extends Client {
    pkg: GrpcPackage;
}

export function getGrpcTestPackage(test: typeof tp.Test.prototype, testProtoFiles: string[] = []) {
    const options = testTnConnectorOptions(test);
    const tncProtos = ["tnc_coaty.proto", "tnc_icc.proto", "tnc_life.proto", "tnc_consensus.proto"]
        .map(p => path.join(options.grpcProtoPath, p));
    const testProtos = testProtoFiles.map(p => path.join("./dist/test/proto", p));
    return new GrpcPackage(tncProtos.concat(testProtos));
}

export function connectGrpcTestClient<T extends GrpcTestClientWithPackage>(
    test: typeof tp.Test.prototype,
    serviceName: string,
    testProtoFiles: string[],
    agentIndex = 0) {
    return new Promise<T>((resolve, reject) => {
        const options = testTnConnectorOptions(test, agentIndex);
        const pkg = getGrpcTestPackage(test, testProtoFiles);
        const client = getGrpcClient(serviceName, pkg.grpcRoot, options.grpcServerPort);
        client.waitForReady(Infinity, err => {
            if (err) {
                reject(new Error(`Test Client couldn't connect: ${err.message}`));
            } else {
                client["pkg"] = pkg;
                resolve(client as T);
            }
        });
    });
}

function getGrpcClient(serviceName: string, grpcRoot: any, port: string): Client {
    const clientDefinition = serviceName.split(".").reduce((o, p) => o[p], grpcRoot);
    return new clientDefinition("localhost:" + port, credentials.createInsecure());
}
