# Transaction Network Connector

[![Powered by Coaty 2](https://img.shields.io/badge/Powered%20by-Coaty%202-FF8C00.svg)](https://coaty.io)
[![TypeScript](https://img.shields.io/badge/Source%20code-TypeScript-007ACC.svg)](http://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Coverage Report](https://coatyio.github.io/transaction-network-connector/lcov-badge.svg)](https://coatyio.github.io/transaction-network-connector/lcov-report/index.html)
[![Latest Release](https://img.shields.io/github/v/release/coatyio/transaction-network-connector)](https://github.com/coatyio/transaction-network-connector/releases/latest)

## Table of Contents

* [Introduction](#introduction)
* [Run with Executables](#run-with-executables)
* [Run with Docker](#run-with-docker)
* [Run with Deployment Bundle](#run-with-deployment-bundle)
* [License](#license)

## Introduction

This project realizes the _Transaction Network Connector_ (aka TN Connector) of
the [FlowPro](https://www.flow-pro.de/) system. The TN Connector provides the
following interfaces according to the FlowPro Deliverable 3.1 "Baseline
Spezifikation Gesamtsystem":

* Routing Interface for Intercomponent Communication within a FlowPro agent
* TN Communication Interface for collaboration between FlowPro agents
* TN Lifecycle Interface for tracking FlowPro agents within the transaction
  network
* TN Consensus Interface for maintaining replicated state among FlowPro agents

The TN Connector runs across platforms and is deployed as:

* a set of platform-specific executables (recommended use)
* a Docker image
* a Deployment Bundle for installation with a [Node.js](https://nodejs.org/)
  runtime

The TN Connector comes with complete
[documentation](https://coatyio.github.io/transaction-network-connector) of its
public interfaces and a developer guide that explains how to use it with your
specific FlowPro agents.

> __NOTE__: This project is delivered "as is" and is no further developed.

## Run with Executables

Executables of the TN Connector are deployed in a versioned zip file named
`tnc-executables.<release-version>.zip` in the associated GitHub
[release](https://github.com/coatyio/transaction-network-connector/releases).
Currently, executables are available for Win-x64, Linux-x64, and macOS-x64
platforms. Unzip the file into your target location, set execute permission and
run the extracted executable.

To access and/or adjust the configuration settings of the TN Connector either
modify the `.env` file extracted alongside the executable or overwrite
corresponding environment variables in the executing shell.

To access the gRPC service definitions inside the executable, run it with the
command line argument `-a`. The following Protobuf files are written into the
target location:

* `tnc_icc.proto` - service definition of Routing Interface for FlowPro
  Intercomponent Communication
* `tnc_coaty.proto` - service definition of TN Communication Interface over
  Coaty
* `tnc_life.proto` - service definition of TN Lifecycle Interface over Coaty
* `tnc_consensus.proto` - service definition of TN Consensus Interface using
  Raft over Coaty

To show the release version of the executable, run it with the command line
argument `-v`.

## Run with Docker

Make sure you have [Docker Engine](https://www.docker.com/) installed on your
target host system.

Versioned Docker images of the TN Connector are deployed to the [GitHub
Container Registry](https://github.com/coatyio/transaction-network-connector).

Start the TN Connector by running its Docker image:

```sh
docker run --rm --env-file .env -p 50060:50060 ghcr.io/coatyio/transaction-network-connector:<release-version>
```

You may pass a complete TNC `.env` file or individual TNC specific environment
variables.

To access the `.env` configuration settings of the TN Connector and its gRPC
service definitions you can bind mount the volume `/assets` to an absolute path
on your host and run the command `assets`:

```sh
docker run --rm \
  -v "$(pwd)"/assets:/assets \
  ghcr.io/coatyio/transaction-network-connector:<release-version> \
  assets
```

The volume `/assets` contains the following files:

* `.env` - defines and documents preconfigured settings which can be overwritten
  by adding corresponding environment variable flags to the `docker run`
  command, e.g. `--env
  FLOWPRO_TNC_COATY_BROKER_URL=mqtt://flowprobrokerhost:1883`
* `tnc_icc.proto` - service definition of Routing Interface for FlowPro
  Intercomponent Communication
* `tnc_coaty.proto` - service definition of TN Communication Interface over
  Coaty
* `tnc_life.proto` - service definition of TN Lifecycle Interface over Coaty
* `tnc_consensus.proto` - service definition of TN Consensus Interface using
  Raft over Coaty.

## Run with Deployment Bundle

As an alternative to prebuild executables or Docker images, the TN Connector can
also be installed locally on any Linux, Windows, macOS, or other platform that
supports Node.js.

As a prerequisite, ensure a long-term-stable (LTS) version of
[Node.js](https://nodejs.org), either version 12, 16, or higher is installed on
the target host.

Deployment bundles of the TN Connector are deployed in a versioned zip file
named `tnc-deploy.<release-version>.zip` in the associated GitHub
[release](https://github.com/coatyio/transaction-network-connector/releases).

Unzip the bundle into your target location. In the target location run `npm
clean-install` to install TN Connector package dependencies.

Start up the TN Connector by running `npm start` in the target location.

> __Tip__: In a production environment you should start up the TN Connector by
> invoking the underlying npm start script directly: `node -r dotenv/config
> dist/main.js`. Bypassing the npm command reduces startup time and the number
> of processes spawned.

To access and/or adjust the configuration settings of the TN Connector either
modify the `.env` file contained in the deployment bundle or overwrite
corresponding environment variables in the executing shell.

The gRPC service definition files of the TN Connector are contained in the
folder `/dist/proto` of the deployment bundle. You can also extract them by
invoking `npm start -- -a`.

To show the release version of the deployment bundle, invoke `npm start -- -v`
or `node -r dotenv/config dist/main.js -v`.

## License

Code and documentation copyright 2023 Siemens AG.

Code is licensed under the [MIT License](https://opensource.org/licenses/MIT).

Documentation is licensed under a
[Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).
