# How to use TN Connector

This developer guide describes how FlowPro agents and components can make use of
the _Transaction Network Connector_ (aka TN Connector) to interact with each
other.

To illustrate the basic concepts, this guide provides programming examples in C#
using the [gRPC for .NET](https://grpc.io/docs/languages/csharp/dotnet/)
implementation. This implementation automatically generates .NET types for gRPC
services and messages by including `*.proto` files in the corresponding project.
A good gRPC tutorial with complete code in C# (and Python) can be found
[here](https://aiki.dev//series/no-nonsense-grpc-guide-for-the-csharp-developers/).
Programming examples for various other gRPC implementations can be found
[here](https://github.com/grpc/grpc/tree/master/examples).

To install the TN Connector on your target platform, refer to the
[README.md](./README.md) file for deployment-specific instructions.

## Table of Contents

* [Getting Started](#getting-started)
* [Routing Service](#routing-service)
  * [Routes](#routes)
  * [One-Way Push Routing](#one-way-push-routing)
  * [Two-Way Request-Response Routing](#two-way-request-response-routing)
* [TN Communication Service](#tn-communication-service)
  * [Configuration](#configuration)
  * [Channel Event Pattern](#channel-event-pattern)
  * [Call-Return Event Pattern](#call-return-event-pattern)
* [TN Lifecycle Service](#tn-lifecycle-service)
* [TN Consensus Service](#tn-consensus-service)
* [License](#license)

## Getting Started

The TN Connector is intended to be run on each FlowPro agent within the system.
It provides the following service interfaces according to the FlowPro
Deliverable 3.1 "Baseline Spezifikation Gesamtsystem":

* Routing Interface for Intercomponent Communication within a FlowPro agent
* TN Communication Interface for collaboration between FlowPro agents
* TN Lifecycle Interface for tracking FlowPro agents within the transaction
  network
* TN Consensus Interface for maintaining a replicated state machine among
  FlowPro agents

These interfaces are realized as [gRPC](https://grpc.io/) services which are
defined using [Protocol Buffers](https://developers.google.com/protocol-buffers)
(aka Protobuf). The services are run on a gRPC server which is hosted inside the
TN Connector. To make use of the services, you have to implement gRPC clients in
your FlowPro agent that connect to the gRPC server and invoke the defined
Remote Procedure Calls (RPCs). As gRPC works across languages and platforms, you
can program gRPC clients in any supported language. Usually, this is an easy
undertaking as gRPC supports automatic generation of client stubs based on the
given gRPC service and message definitions.

If you are new to gRPC or would like to learn more, we recommend reading the
following documentation:

* Introduction to gRPC: [https://grpc.io](https://grpc.io)
* gRPC documentation and supported programming languages:
  [https://grpc.io/docs/](https://grpc.io/docs/)
* Protobuf developer guide:
  [https://developers.google.com/protocol-buffers/docs/overview](https://developers.google.com/protocol-buffers/docs/overview)
* Protobuf language references:
  [https://developers.google.com/protocol-buffers/docs/reference/overview](https://developers.google.com/protocol-buffers/docs/reference/overview)

To program a gRPC client for one of the TN Connector services, follow these
steps:

1. Get the service-specific Protobuf definition file (see
   [README.md](./README.md) on how to extract `.proto` files from TN Connector
   deliverables).
2. Define your FlowPro interface-specific Protobuf message types in a separate
   Protobuf file.
3. Generate gRPC client stubs from service protos and interface-specific protos
   using the recommended language-specific tool/compiler. Some programming
   languages, like JavaScript, also support dynamic loading and use of service
   definitions at runtime.
4. Implement FlowPro specific application logic by programming handler functions
   for individual service RPCs. Application-specific data is passed to service
   RPCs using the well-known `google.protobuf.Any` message type. Therefore, you
   must pack your message types into `Any` messages on the sending side, and
   unpack the `Any` messages on the receiving side. gRPC implementations provide
   support to pack/unpack `Any` messages in the form of utility functions or
   additional generated methods of the `Any` type.

> **Note**: You never need to write a gRPC _server_ in your FlowPro agent as the
> TN Connector serves as a gateway that interconnects your loosely coupled gRPC
> clients and routes information between them. Distinct clients can take over
> the role of either a service requester or a service provider.

When programming gRPC clients for the TN Connector services follow these
guidelines:

* Always use `proto3` syntax in your Protobuf definition files.
* Use a separate proto `package` name for each FlowPro interface in the format
  `flowpro.if.{datamodelgroup}` to prevent name clashes between interfaces, like
  `flowpro.if.topologymaps`. Package names must not contain uppercase letters.
* Name your Protobuf definition files according to their package names,
  converting each dot to an underscore character and omitting the prefix
  `flowpro_`, like `if_topologymaps.proto`.
* Set useful deadlines/timeouts in your gRPC client calls for how long you are
  willing to wait for a reply from the server.
* Handle potential errors/cancellations for your gRPC client calls. The TN
  Connector services use the standard gRPC error model as described
  [here](https://www.grpc.io/docs/guides/error/). Specific errors returned by
  service RPCs are documented in the corresponding Protobuf files.
* Read the detailed documentation on individual RPCs and message types included
  in the Protobuf files of the TNC Connector services, namely `tnc_icc.proto`,
  `tnc_coaty.proto`, and `tnc_life.proto`.

## Routing Service

The Routing Service routes event data send by source gRPC clients to destination
gRPC clients that have registered interest in specific _routes_ and that can
also route back response events. gRPC clients do not need to know the endpoint
addresses of their communication partners as they solely communicate with the
gRPC server that provides the Routing Service. In contrast to classic
client-server systems, all gRPC clients are equal in that they can act both as
producers/requesters and consumers/responders.

By providing a generic routing service, different components of a FlowPro agent
can exchange application-specific data using loosely coupled one-way push
(one-to-many) or two-way request-response (one-to-one) routing flows with a
common domain-specific data model defined by Protobuf. Thereby, the Routing
Service combines classic publish-subscribe communication with classic
request-response communication.

Use this Routing Service to implement FlowPro interfaces that require

* sending data from one FlowPro component to one or many interested FlowPro
  components within the _same_ FlowPro agent,
* exchanging data between two FlowPro components within the _same_ FlowPro
  agent.

Do not use this Routing Service for FlowPro interfaces that require

* one-to-many communication _between_ different FlowPro agents to interact in a
  collaborative, decentralized, autonomous, and ad-hoc fashion,
* one-to-many request-response communication with _multiple_ reponses per
  request from a single or multiple responders over time.

In these cases use the [TN Communication Service](#tn-communication-service).

### Routes

Basically, a _route_ is defined as a string that uniquely identifies a
communication flow between gRPC clients:

* A _one-way route_ is used to push data from a producing gRPC client to all
  consuming gRPC clients that _registered_ this route.
* A _two-way route_ is used to exchange data between a requesting gRPC client
  and a single responding gRPC client that _registered_ this route.
  
Additional registrations on a two-way route may be accepted by the Routing
Service depending on the specified _routing policy_:

* `single` - route a request event to a single registration only (default
  policy). Additional registrations are rejected with a gRPC error.
* `first` - route a request event to the first registration. This policy may be
  used for hot standby routing. Additional registrations must also specify this
  policy to be accepted, otherwise they are rejected with a gRPC error.
* `last` - route a request event to the last registration. This policy may be
  used for hot standby routing. Additional registrations must also specify this
  policy to be accepted, otherwise they are rejected with a gRPC error.
* `next`- route a request event to a registration, one after the other in a
  round-robin style. This policy may be used for load-balanced routing.
  Additional registrations must also specify this policy to be accepted,
  otherwise they are rejected with a gRPC error.
* `random`- route a request event to a randomly chosen registration. This policy
   may be used for load-balanced routing. Additional registrations must also
   specify this policy to be accepted, otherwise they are rejected with a gRPC
   error.

When defining routes for different FlowPro interfaces make sure to uniquely name
them to prevent clashes. We recommend to define dot-namespaced routes starting
with the prefix `flowpro.icc.{datamodelgroup}.` followed by the name of the
operation to be performed on the route. For example,

* `flowpro.icc.ftf.FtfStatus` - a one-way route to push FTF status data
* `flowpro.icc.ftf.GetFtfStatus` - a two-way route to request FTF status data
* `flowpro.icc.ftf.UpdateFtfStatus` - a two-way route to update FTF status data

> **Tip**: Define _distinct_ routes for distinct operations with specific
> message types as shown above. Only in this way it is possible to provide
> _efficient_ routing flows for clients that are solely interested in a specific
> subset of all operations.

### One-Way Push Routing

Consider the following scenario: a FlowPro FTF agent wants to report FTF Status
data to an associated GUI component for supervision and operational support by a
human expert (as specified in FlowPro Deliverable 3.1 "Baseline Spezifikation
Gesamtsystem" in section 5.1, Interface ID I-07).

First, create a Protobuf file named `if_ftf.proto` that - among others - defines
Protobuf message types for modelling FTF Status as specified in FlowPro
Deliverable 3.1 in sections 4.2.2, and 5.5.9.

```protobuf
syntax = "proto3";

package flowpro.if.ftf;

import "if_topologymaps.proto";

/**
 * Used by FlowPro Interfaces:
 *
 * I-07 - Routing Service
 *   "flowpro.icc.ftf.FtfStatus" - one-way route with push type 'FtfStatus'
 *   "flowpro.icc.ftf.GetFtfStatus" - two-way route with request type 'google.protobuf.Empty' and response type 'FtfStatus'
 */

message FtfStatus {
  string id = 1;
  int64 timestamp = 2;
  string agv_id = 3;
  flowpro.if.topologymaps.Position agv_position = 4;
  string map_ref_id = 5;
  string current_edge_node_name = 6;
  int32 agv_battery_health = 7;
  bool agv_station_connected = 8;
  bool agv_charging_connected = 9;
  AgvChargingStage agv_charging_stage = 10;
  repeated string agv_error_states = 11;
  double agv_velocity = 12;
  bool agv_load_state = 13;
  bool agv_emergency_stop = 14;
  AgvLoadExchangeDeviceState agv_load_exchange_device_state = 15;
}

enum AgvChargingStage {
    AGV_CHARGING_STAGE_UNSPECIFIED = 0;
    AGV_CHARGING_STAGE_CHARGING = 3;
    AGV_CHARGING_STAGE_BALANCING = 4;
    AGV_CHARGING_STAGE_CHARGED = 5;
    AGV_CHARGING_STAGE_ABORTED = 6;
}

enum AgvLoadExchangeDeviceState {
    AGV_LOAD_EXCHANGE_DEVICE_STATE_UNSPECIFIED = 0;
    AGV_LOAD_EXCHANGE_DEVICE_STATE_BUSY = 2;
    AGV_LOAD_EXCHANGE_DEVICE_STATE_ERROR = 3;
}
```

This Protobuf file depends on message types defined in the data model group
`topologymaps` (see sections 5.8.2, and 5.8.3), for which a separate Protobuf
definition file named `if_topologymaps.proto` exists:

```protobuf
syntax = "proto3";

package flowpro.if.topologymaps;

message Position {
  string ref_frame = 1;
  double pos_x = 2;
  double pos_y = 3;
  double pos_z = 4;
  repeated Orientation pos_orientations = 5;
}

message Orientation {
  double yaw = 1;
  double pitch = 2;
  double roll = 3;
}
```

> **Note**: In your Protobuf files you should _document_ which FlowPro
> Interfaces make use of the defined _top-level_ message types utilizing either
> the Routing Service or the TN Communication Service. For routing operations,
> all routes should be documented together with their message types as shown
> above. Application-specific errors returned in response events should also be
> documented here.

Include these two Protobuf files and the Routing Service proto file
`tnc_icc.proto` in your client projects and set their build action to "Protobuf
compiler" (or "Protobuf" in .NET) in Visual Studio so that .NET types for gRPC
clients and messages are generated automatically by the build process. In order
for it to work, you must have installed the nuget package Grpc.Tools beforehand.

Then, create and connect a gRPC client that plays the role of a service provider
for FlowPro Interface I-07.

```csharp
using Grpc.Net.Client;
using Flowpro.Tnc.Icc;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// using Grpc.Core;
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var ftfClient = new RoutingService.RoutingServiceClient(channel);
```

Next, create and connect a gRPC client that plays the role of a service consumer
(GUI) for FlowPro Interface I-07.

```csharp
using Grpc.Net.Client;
using Flowpro.Tnc.Icc;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// using Grpc.Core;
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var guiClient = new RoutingService.RoutingServiceClient(channel);
```

> **Note**: The port numbers must match the port of the gRPC server running
> inside the TN Connector. It is preconfigured to `50060` but can be changed in
> the configuration settings of the TN Connector.
>
> **Note**: Currently, the gRPC server inside the TN Connector is trusted, i.e.
> gRPC clients use an insecure connection without TLS.

Whenever FTF status changes, the `ftfClient` asynchronously pushes new status
data on the one-way route `flowpro.icc.ftf.FtfStatus` and awaits an
acknowledgment by the Routing Service.

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Flowpro.Tnc.Icc;
using Flowpro.If.Ftf;

var status = new FtfStatus
{
    Id = "c8da24fc-3ef6-45d9-bc9c-03e3fe32a341",
    Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    AgvId = "ftf0004",
    AgvPosition = new Position { PosX = 10, PosY = 20, PosZ = 0 },
    MapRefId = "local",
    CurrentEdgeNodeName = "Node_42",
    AgvBatteryHealth = 95,
    AgvStationConnected = true,
    AgvChargingConnected = false,
    AgvChargingStage = AgvChargingStage.Unspecified,
    AgvVelocity = 1.5,
    AgvLoadState = false,
    AgvEmergencyStop = false,
    AgvLoadExchangeDeviceState = AgvLoadExchangeDeviceState.Unspecified
};
var pushEvent = new PushEvent
{
    Route = "flowpro.icc.ftf.FtfStatus",

    // Pack FTF status into data field of type Any.
    Data = AnyMessage.Pack(status)
};

try
{
    var ack = await ftfClient.PushAsync(pushEvent);
    Console.WriteLine("Pushed FTF status to {0:N} observers", ack.RoutingCount);
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error pushing FTF status: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

The `guiClient` observes these FTF status changes by registering the associated
one-way route and handling incoming push events on a server streaming call.

```csharp
using System;
using Grpc.Core;
using Flowpro.Tnc.Icc;
using Flowpro.If.Ftf;

using var streamingCall = guiClient.RegisterPushRoute(new PushRoute { Route = "flowpro.icc.ftf.FtfStatus" });

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var pushEvent = streamingCall.ResponseStream.Current;
    //     ...
    // } 
    await foreach (var pushEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        // Check if push data is of the expected message type.
        if (pushEvent.Data.Is(FtfStatus.Descriptor))
        {
            // Unpack FTF status from data field of type Any.
            var status = pushEvent.Data.Unpack<FtfStatus>();
            Console.WriteLine("Received FTF status with Id {0}", status.Id);
        }
        else
        {
            Console.WriteLine("Discarding unknown push data");
        }
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error observing FTF status push route: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

> **Note**: The Routing Service uses the Protobuf well-known message type `Any`
> to route data of any application-specific message type without the need to
> know its `.proto` definition. Therefore, application-specific message types
> have to be packed into and unpacked from this `Any` type by the gRPC clients.
> Make sure that when unpacking `Any` messages, received data should always be
> checked against the expected message type.

### Two-Way Request-Response Routing

Consider a (fictive) scenario where FTF status data is not pushed by the FTF
agent as described in the previous section but instead pulled by the GUI client
on demand.

The `guiClient` requests the current FTF status by asynchronously sending a
request event with empty data (or alternatively without data) on the two-way
route `flowpro.icc.ftf.GetFtfStatus` and awaiting a response event with the
status data. The `guiClient` must always handle response errors, e.g. in case
request data is invalid or result data could not be computed.

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Empty = Google.Protobuf.WellKnownTypes.Empty;
using Flowpro.Tnc.Icc;
using Flowpro.If.Ftf;

var requestEvent = new RequestEvent
{
    Route = "flowpro.icc.ftf.GetFtfStatus",

    // Pack Empty message into data field of type Any.
    // Alternatively, you may also omit the Data field.
    Data = AnyMessage.Pack(new Empty())
};

try
{
    var responseEvent = await guiClient.RequestAsync(requestEvent);

    // Discriminate between result data and error in response event.
    switch (responseEvent.ResultCase)
    {
        case ResponseEvent.ResultOneofCase.Data:
            // Check if response result is of the expected message type.
            if (responseEvent.Data.Is(FtfStatus.Descriptor))
            {
                // Unpack FTF status from result field of type Any.
                var ftfStatus = responseEvent.Data.Unpack<FtfStatus>();
                Console.WriteLine("Received FTF status with Id {0}", ftfStatus.Id);
            }
            else
            {
                Console.WriteLine("Discarding unknown result data");
            }
            break;
        case ResponseMessage.ResultOneofCase.Error:
            Console.WriteLine("Received error: {0}", responseEvent.Error);
            break;
        default:
            Console.WriteLine("Unexpected result");
            break;
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error requesting FTF status: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

The `ftfClient` observes incoming request events by registering the
corresponding two-way route and sends a response event for each request on a
server streaming call. In case of invalid request event data or in case a result
cannot be computed, the `ftfClient` must respond with an error that is
propagated to the requesting `guiClient` by the Routing Service.

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Empty = Google.Protobuf.WellKnownTypes.Empty;
using Flowpro.Tnc.Icc;
using Flowpro.If.Ftf;

using var streamingCall = ftfClient.RegisterRequestRoute(new RequestRoute { Route = "flowpro.icc.ftf.GetFtfStatus" });

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var requestEvent = streamingCall.ResponseStream.Current;
    //     ...
    // } 
    await foreach (var requestEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        // Check if request data is of the expected message type.
        if (requestEvent.Data == null || requestEvent.Data.Is(Empty.Descriptor))
        {
            // No need to unpack Empty message as it is not used.
            Console.WriteLine("Received request for FTF status");

            // Respond with current FTF status.
            var ftfStatus = getCurrentFtfStatus();
            var responseEvent = new ResponseEvent
            {
                // Take over these fields to correlate response with given request.
                Route = requestEvent.Route,
                RequestId = requestEvent.RequestId,

                // Pack current FTF Status into oneof data field of type Any.
                Data = AnyMessage.Pack(ftfStatus)
            };
            var ack = await ftfClient.RespondAsync(responseEvent);
            Console.WriteLine("Response {0} routed back to requester", ack.RoutingCount == 0 ? "not" : "");
        }
        else
        {
            // Respond with an error as request data is invalid.
            var responseEvent = new ResponseEvent
            {
                // Take over these fields to correlate response with given request.
                Route = requestEvent.Route,
                RequestId = requestEvent.RequestId,

                // Set application-specific error identifier in oneof error field.
                Error = "INVALID_REQUEST_DATA"
            };
            var ack = await ftfClient.RespondAsync(responseEvent);
            Console.WriteLine("Response error {0} routed back to requester", ack.RoutingCount == 0 ? "not" : "");
        }
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error observing FTF status request route: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

## TN Communication Service

The Transaction Network Communication Service provides an interface for
communication between FlowPro agents over [Coaty](https://coaty.io).

Coaty uses event-based communication flows with one-way/two-way and
one-to-many/many-to-many event patterns to realize decentralized prosumer
scenarios. Thereby, Coaty combines the characteristics of both classic
request-response and publish-subscribe communication. In contrast to classic
client-server systems, all Coaty participants are equal in that they can act
both as producers/requesters and consumers/responders.

The TN Communication Service provides a gateway to gRPC clients to act as Coaty
agents that can publish and observe a limited subset of Coaty communication
event patterns, namely one-way `Channel` and two-way `Call-Return` as explained
in the following subsections.

> **Note**: gRPC clients using this service may pass arbitrary
> application-specific data of Protocol Buffers well-known `Any` type in Coaty
> events. Coaty objects (in JSON format) are not directly exposed to gRPC
> clients as they are dynamically created by the service.

### Configuration

Coaty communication is based on the MQTT publish-subscribe messaging protocol.
To make use of it you need to install an MQTT Broker of your choice in your
networking infrastructure, such as Mosquitto or HiveMQ.

Coaty communication options such as the connection URL to the MQTT Broker and
TLS authentication can be configured within the TN Communication Service in two
ways:

* Use predefined environment variables at startup of TN Connector (for details,
  see [README.md](./README.md)).
* Configure options dynamically at runtime of TN Connector by invoking the gRPC
  method `Configure` of the TN Communication Service.

To dynamically configure the MQTT Broker URL and the name of the agent's
identity proceed as follows:

```csharp
using System;
using Grpc.Core;
using Grpc.Net.Client;
using Flowpro.Tnc.Coaty;
using Flowpro.Tnc.Life;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var configClient = new CommunicationService.CommunicationServiceClient(channel);

var options = new CoatyCommunicationOptions
{
    BrokerUrl = "mqtt://193.164.2.107:1883",
    AgentIdentity = new AgentIdentity { Name = "AGV Agent ABB1" }
};

try
{
    await configClient.ConfigureAsync(options);
    Console.WriteLine("Configured TN communication options");
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error configuring TN communication options: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

> **Note**: Whenever TN communication options are reconfigured in a running TN
> Connector, Coaty communication is stopped and restarted afterwards with the
> new options. This causes all current gRPC server streaming calls on methods
> `ObserveChannel` and `ObserveCall` to be terminated explicitly by the TN
> Communication Service.
>
> **Note**: Communication options not specified in the Configure call are kept
> unchanged, i.e. they keep their latest configured value - if any - or their
> default value.

### Channel Event Pattern

In the Coaty communication protocol, the one-way `Channel` event pattern is used
to multicast objects to parties interested in any kind of objects delivered
through a channel with a specific channel identifier. The TN Communication
Service facilitates use of this pattern by providing an easy-to-use gRPC facade
which uses arbitrary application-specific data of Protocol Buffers well-known
`Any` type to be submitted in a Coaty channel event.

Consider the following scenario: a FlowPro agent wants to report changes in Job
Status to other interested FlowPro agents (as specified in FlowPro Deliverable
3.1 "Baseline Spezifikation Gesamtsystem" in section 5.2.3, Data Model Group
"Transportauftragsmanagement").

First, create a Protobuf file named `if_transport.proto` that - among others -
defines a Protobuf message type for modelling Job Status as specified in FlowPro
Deliverable 3.1 in section 5.2.3.

```protobuf
syntax = "proto3";

package flowpro.if.transport;

message JobStatus {
    string id = 1;
    string job_id = 2;
    string parent_job_id = 3;
    string job_assignee_id = 4;
    JobState job_state = 5;
    int64 job_state_timestamp = 6;
    int64 job_execution_started_timestamp = 7;
    int64 job_execution_finished_timestamp = 8;
    repeated ActionState action_states = 9;
    repeated JobError job_errors = 10;
}

...
```

Include this Protobuf file and the TN Communication Service proto file
`tnc_coaty.proto` in your client projects so that .NET types for gRPC clients
and messages are generated automatically by the build process.

Then, create and connect a gRPC client that plays the role of a service
provider.

```csharp
using Grpc.Net.Client;
using Flowpro.Tnc.Coaty;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// using Grpc.Core;
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var transportClient = new CommunicationService.CommunicationServiceClient(channel);
```

Next, create and connect a gRPC client that plays the role of a service consumer.

```csharp
using Grpc.Net.Client;
using Flowpro.Tnc.Coaty;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// using Grpc.Core;
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var observingClient = new CommunicationService.CommunicationServiceClient(channel);
```

> **Note**: The port numbers must match the port of the gRPC server running
> inside the TN Connector. It is preconfigured to `50060` but can be changed in
> the configuration settings of the TN Connector.
>
> **Note**: Currently, the gRPC server inside the TN Connector is trusted, i.e.
> gRPC clients use an insecure connection without TLS.

Whenever job status changes, the `transportClient` asynchronously publishes new
status data on the channel identified by `flowpro.coaty.transport.JobStatus` and
awaits an acknowledgment by the TN Communication Service.

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Flowpro.Tnc.Coaty;
using Flowpro.If.Transport;

var status = new JobStatus
{
    Id = "ec9729c5-0839-49df-b0ad-d5e3311f0787",
    JobId = "9c544876-e49f-4093-b3cd-28b2c21b35b7",
    ...
};
var channelEvent = new ChannelEvent
{
    Id = "flowpro.coaty.transport.JobStatus",

    // Pack job status into data field of type Any.
    Data = AnyMessage.Pack(status),

    // Unique identifier of the gRPC client that sends this Channel event.
    SourceId = "751b423e-7d8b-4b35-83f6-a20500391c4e"
};

try
{
    await transportClient.PublishChannelAsync(channelEvent);
    Console.WriteLine("Published job status");
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error publishing job status on channel: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

When defining channel identifiers for different FlowPro interfaces make sure to
uniquely name them to prevent clashes. We recommend to define dot-namespaced
identifiers starting with the prefix `flowpro.coaty.{datamodelgroup}.` followed
by the message type of the data to be submitted on the channel, like
`flowpro.coaty.transport.JobStatus`.

> **Tip**: Define _distinct_ identifiers for distinct channels with specific
> message types as shown above. Only in this way it is possible to provide
> _efficient_ communication flows for clients that are solely interested in a
> specific subset of all channels.

The `observingClient` observes these job status changes on the corresponding
channel identifier and handles incoming channel events on a server streaming
call.

```csharp
using System;
using Grpc.Core;
using Flowpro.Tnc.Coaty;
using Flowpro.If.Transport;

using var streamingCall = observingClient.observeChannel(new ChannelSelector { Operation = "flowpro.coaty.transport.JobStatus" });

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var channelEvent = streamingCall.ResponseStream.Current;
    //     ...
    // } 
    await foreach (var channelEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        // Check if channel data is of the expected message type.
        if (channelEvent.Data.Is(JobStatus.Descriptor))
        {
            // Unpack job status from data field of type Any.
            var status = channelEvent.Data.Unpack<JobStatus>();
            Console.WriteLine("Received job status with Id {0}", status.Id);
        }
        else
        {
            Console.WriteLine("Discarding unknown channel data");
        }
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error observing job status on channel: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

> **Note**: The TN Communication Service uses the Protobuf well-known message
> type `Any` to submit channel data of any application-specific message type
> without the need to know its `.proto` definition. Therefore,
> application-specific message types have to be packed into and unpacked from
> this `Any` type by the gRPC clients. Make sure that when unpacking `Any`
> messages, received data should always be checked against the expected message
> type.
>
> **Note**: By default, in case the Coaty agent is currently offline, the rpc
> methods PublishChannel and ObserveChannel fail fast by signalling a gRPC error
> with status code `UNAVAILABLE` (14). This behavior can be disabled by
> configuring a corresponding Coaty communication option. If disabled the Coaty
> agent automatically defers publications and observations and applies them as
> soon as the Coaty connection is (re)established.

### Call-Return Event Pattern

In the Coaty communication protocol, the two-way `Call-Return` event pattern is
used to request execution of a remote operation and receive any number of
results over time by Return events. The published Call event is multicast to all
observers that have registered interest in the given call operation. Each
observer can decide to send back no response at all, a single response, or
multiple responses over time. For example, it may be desirable for some remote
operation calls to submit a progressive series of call results, e.g. to return
partial data in chunks or progress status of long running operations, even
simultaneously by different observers.

> Citing [Coaty - In a Nutshell](https://coaty.io/nutshell): _"One of the unique
> features of Coaty communication is the fact that a single request in principle
> can yield multiple responses over time, even from the same responder. The use
> case specific logic implemented by the requester determines how to handle such
> responses. For example, the requester can decide to just take the first
> response and ignore all others, only take responses received within a given
> time interval, only take responses until a specific condition is met, handle
> any response over time, or process responses as defined by any other
> application-specific logic."_

The TN Communication Service facilitates use of this two-way multi-response
pattern by providing an easy-to-use gRPC facade which uses arbitrary
application-specific data of Protocol Buffers well-known `Any` type to be
submitted in Coaty Call/Return events.

Consider the following scenario: a FlowPro agent wants to negotiate an incoming
job request among all available FTF agents in a blind auction: The job request
is submitted to all FTF agents and each of them can submit a sealed bid within a
given bidding period. The job is finally assigned to the best bidder.

To realize this scenario, `jobClient` requests bids by asynchronously publishing
a Call event on the operation `flowpro.coaty.auction.Bid` and awaiting Return
events with bids from distinct `biddingClients` until the bidding period of 5
seconds expires.

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Flowpro.Tnc.Coaty;
using Flowpro.If.Auction;
using Flowpro.If.Transport;

var job = new Job {
    Id = "fadea703-bc55-428b-b45c-846b80ecb239",
    Type = "transport",
    ...
};

var callEvent = new CallEvent
{
    Operation = "flowpro.coaty.auction.Bid",

    // Pack BiddingStart message into parameters field of type Any.
    Parameters = AnyMessage.Pack(new BiddingStart {
        JobDetails = job,
        AuctionId = "84e5e1db-8e13-4244-81bf-d3c7a5da5306"
    }),

    SourceId = "1dac169a-f417-497c-abd5-915f5323d673"
};

using var streamingCall = jobClient.publishCall(callEvent, deadline: DateTime.UtcNow.AddSeconds(5)));

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var returnEvent = streamingCall.ResponseStream.Current;
    //     ...
    // } 
    await foreach (var returnEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        // Discriminate between result data and error in Return event.
        switch (returnEvent.ResultCase)
        {
            case ReturnEvent.ResultOneofCase.Data:
                // Check if Return result is of the expected message type Bid.
                if (returnEvent.Data.Is(Bid.Descriptor))
                {
                    // Unpack Bid from result field of type Any.
                    var bid = returnEvent.Data.Unpack<Bid>();
                    Console.WriteLine("Received bid {0:N} by {1}", bid.Bid, returnEvent.SourceId);
                }
                else
                {
                    Console.WriteLine("Discarding unknown return data");
                }
                break;
            case ResponseMessage.ResultOneofCase.Error:
                Console.WriteLine("Received error: code: {0:N}, message: {1}", returnEvent.Error.Code, returnEvent.Error.Message);
                break;
            default:
                Console.WriteLine("Unexpected result");
                break;
        }
    }
}
catch (RpcException ex) when (ex.StatusCode == StatusCode.Cancelled)
{               
    Console.WriteLine("Deadline exceeded: streaming call cancelled");
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error publishing bidding start: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

Note that the method `PublishCall` specifies a deadline indicating how long the
caller will wait for bidders to submit their bids before the call is cancelled.

A `biddingClient` can observe such bidding requests and respond to them as
follows:

```csharp
using System;
using Grpc.Core;
using AnyMessage = Google.Protobuf.WellKnownTypes.Any;
using Flowpro.Tnc.Coaty;
using Flowpro.If.Auction;
using Flowpro.If.Transport;

var callEvent = new CallEvent
{
    Operation = "flowpro.coaty.auction.Bid",

    // Pack BiddingStart message into parameters field of type Any.
    Parameters = AnyMessage.Pack(new BiddingStart {
        JobDetails = job,
        AuctionId = "84e5e1db-8e13-4244-81bf-d3c7a5da5306"
    }),

    SourceId = "1dac169a-f417-497c-abd5-915f5323d673"
};

using var streamingCall = biddingClient.observeCall(new CallSelector { Operation = "flowpro.coaty.auction.Bid" });

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var callEvent = streamingCall.ResponseStream.Current;
    //     ...
    // }
    await foreach (var callEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        // Check if parameters is of the expected message type.
        if (callEvent.Parameters.Is(BiddingStart.Descriptor))
        {
            // Unpack BiddingStart from parameters field of type Any.
            var biddingStart = callEvent.Parameters.Unpack<BiddingStart>();
            Console.WriteLine("Received bidding start for auction Id {0}", biddingStart.AuctionId);

            // Respond with a computed bid value of message type Bid.
            var bid = await computeBidForJob(biddingStart.JobDetails);
            var returnEvent = new ReturnEvent
            {
                // Take over this fields to correlate response with given request.
                CorrelationId = callEvent.CorrelationId,

                // Pack computed Bid object into oneof data field of type Any.
                Data = AnyMessage.Pack(bid),

                SourceId = "6b6eabf0-e38d-417f-81c2-538387293fde",
            };
            await biddingClient.PublishReturnAsync(returnEvent);
            Console.WriteLine("Bid {0:N} by {1} send back to caller", bid.Bid, returnEvent.SourceId);
        }
        else
        {
            Console.WriteLine("Discarding unknown call parameters");
        }

        // Finally send a Complete event back to service to indicate that no
        // more responses for this call request will follow.
        await biddingClient.PublishCompleteAsync(new CompleteEvent { CorrelationId = callEvent.CorrelationId });
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error observing bidding start: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

> **Note**: By default, in case the Coaty agent is currently offline, the rpc
> methods PublishCall, ObserveCall, and PublishReturn fail fast by signalling a
> gRPC error with status code `UNAVAILABLE` (14). This behavior can be disabled
> by configuring a corresponding Coaty communication option. If disabled the
> Coaty agent automatically defers publications and observations and applies
> them as soon as the Coaty connection is (re)established.

## TN Lifecycle Service

The Transaction Network Lifecycle Service provides an interface for tracking
FlowPro agents within the transaction network over [Coaty](https://coaty.io).

This gRPC service enables a TN connector to track TNC agents using Coaty
Distributed Lifecycle Management. It allows you to monitor other agents joining
or leaving the transaction network.

To properly track other FlowPro agents and to distinguish between them, each
agent should be configured with a unique and descriptive identity consisting of
a name and an identifier as defined by Protobuf message `AgentIdentity` in
`tnc_life.proto`. You may either configure an agent's identity by predefined
environment variables or by invoking a gRPC configuration method at runtime. For
details, see section [Configuration](#configuration).

To track agents, create and connect a gRPC client that observes tracking events.

```csharp
using Grpc.Net.Client;
using Flowpro.Tnc.Life;

// .NET Core 3.x requires this context switch to be enabled for insecure gRPC
// services (over http instead of https) before creating the gRPC channel:
AppContext.SetSwitch("System.Net.Http.SocketsHttpHandler.Http2UnencryptedSupport", true);

// In .NET Framework, create a Channel as follows:
// using Grpc.Core;
// var channel = new Channel("localhost", 50060, ChannelCredentials.Insecure);
using var channel = GrpcChannel.ForAddress("http://localhost:50060");
var trackingClient = new LifecycleService.LifecycleServiceClient(channel);
```

> **Note**: The port numbers must match the port of the gRPC server running
> inside the TN Connector. It is preconfigured to `50060` but can be changed in
> the configuration settings of the TN Connector.
>
> **Note**: Currently, the gRPC server inside the TN Connector is trusted, i.e.
> gRPC clients use an insecure connection without TLS.

The `trackingClient` observes agents to be tracked by an agent selector and
handles incoming agent lifecycle events on a server streaming call.

```csharp
using System;
using Grpc.Core;
using Flowpro.Tnc.Life;

using var streamingCall = trackingClient.trackAgents(new AgentSelector {
        // Track all agents whose name starts with "AGV Agent ABB" followed by
        // one or more digits. 
        IdentityName = "/^AGV Agent ABB\d+$/" 
    });

try
{
    // In .NET Framework, use instead:
    // while (await streamingCall.ResponseStream.MoveNext())
    // {
    //     var lifecycleEvent = streamingCall.ResponseStream.Current;
    //     ...
    // } 
    await foreach (var lifecycleEvent in streamingCall.ResponseStream.ReadAllAsync())
    {
        switch (lifecycleEvent.State)
        {
            case AgentLifecycleState.Join:
                Console.WriteLine("Agent {0} joined (local={1})", lifecycleEvent.Identity.Name, lifecycleEvent.Identity.Local);
                break;
            case  AgentLifecycleState.Leave:
                Console.WriteLine("Agent {0} left (local={1})", lifecycleEvent.Identity.Name, lifecycleEvent.Identity.Local);
                break;
            default:
                Console.WriteLine("Unexpected lifecycle state");
                break;
        }
    }
}
catch (RpcException ex)
{
    // Handle gRPC specific errors.
    Console.WriteLine("Error tracking agents: {0:N}: {1}", ex.StatusCode, ex.Status.Detail);
}
```

> **Note**: The agent selector allows you to track all agents in the transaction
> network, or a specific subset of agents matching given name(s) or an
> identifier. The local TNC agent on which this call has been invoked is also
> tracked if the specified agent selector applies. You can distinguish the local
> agent from remote ones by the field `AgentLifecycleEvent.local`.
>
> **Note**: The lifecycle event is also emitted initially, i.e. when the method
> `trackAgents` has been invoked, to yield the latest lifecycle state of
> selected agents to be tracked.
>
> **Note**: By default, in case the Coaty agent is currently offline, the rpc
> method TrackAgents fails fast by signalling a gRPC error with status code
> `UNAVAILABLE` (14). This behavior can be disabled by configuring a
> corresponding Coaty communication option. If disabled the Coaty agent
> automatically defers tracking observations and applies them as soon as the
> Coaty connection is (re)established.

## TN Consensus Service

The Transaction Network Consensus Service provides an interface for maintaining
a replicated state machine (RSM) among FlowPro agents using the [Raft Consensus
Algorithm over Coaty](https://github.com/coatyio/consensus.raft.js).

This gRPC Consensus service enables a TN connector to share distributed state
within the transaction network. Replicated state is represented as a key-value
store with key-value pairs that can be set, changed, or removed. Whereas keys
are strings, values can be any JSON compatible value represented by Protobuf
well-known type `google.protobuf.Value`.

Detailed documentation of the gRPC Consensus service can be found in its
Protobuf definition file `tnc_consensus.proto`.

Note that the database persistence of the replicated state of each Raft node is
configurable by the environment variable `FLOWPRO_TNC_CONSENSUS_DATABASE_FOLDER`
(see `.env` file).

## License

Code and documentation copyright 2023 Siemens AG.

Code is licensed under the [MIT License](https://opensource.org/licenses/MIT).

Documentation is licensed under a
[Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).
