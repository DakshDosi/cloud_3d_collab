# Detailed Architecture Documentation

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           CLIENT LAYER (Browser)                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                         User Interface                            │   │
│  │  - Control Panel (Add/Delete objects)                            │   │
│  │  - User List (Active collaborators)                              │   │
│  │  - Selected Object Info                                           │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                                │                                          │
│  ┌────────────────────────────▼─────────────────────────────────────┐   │
│  │                    Three.js Renderer                              │   │
│  │  - 3D Scene rendering                                             │   │
│  │  - Camera controls (OrbitControls)                                │   │
│  │  - Raycasting for object selection                                │   │
│  │  - Mesh management (create/update/delete)                         │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                                │                                          │
│  ┌────────────────────────────▼─────────────────────────────────────┐   │
│  │                   Local CRDT Store                                │   │
│  │  ┌─────────────────────────────────────────────────────────────┐ │   │
│  │  │  Objects Map: objectId → CRDTObject                         │ │   │
│  │  │  - transform.position: LWWRegister                          │ │   │
│  │  │  - transform.rotation: LWWRegister                          │ │   │
│  │  │  - transform.scale: LWWRegister                             │ │   │
│  │  │  - metadata.color: LWWRegister                              │ │   │
│  │  │  - metadata.name: LWWRegister                               │ │   │
│  │  └─────────────────────────────────────────────────────────────┘ │   │
│  │  ┌─────────────────────────────────────────────────────────────┐ │   │
│  │  │  Vector Clock: { clientId → sequenceNumber }                │ │   │
│  │  │  - Tracks causal dependencies                                │ │   │
│  │  │  - Incremented on each local operation                       │ │   │
│  │  └─────────────────────────────────────────────────────────────┘ │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                                │                                          │
│  ┌────────────────────────────▼─────────────────────────────────────┐   │
│  │                  WebSocket Client                                 │   │
│  │  - Persistent connection to server                                │   │
│  │  - Send operations (create, delete, transform, metadata)          │   │
│  │  - Receive operations from other users                            │   │
│  │  - Heartbeat / ping-pong                                          │   │
│  │  - Auto-reconnect with exponential backoff                        │   │
│  └────────────────────────────┬─────────────────────────────────────┘   │
│                                │                                          │
└────────────────────────────────┼──────────────────────────────────────────┘
                                 │
                                 │ WebSocket (JSON Messages)
                                 │ ws://localhost:8080
                                 │
┌────────────────────────────────┼──────────────────────────────────────────┐
│                          SERVER LAYER (Node.js)                           │
├────────────────────────────────┼──────────────────────────────────────────┤
│                                │                                           │
│  ┌────────────────────────────▼─────────────────────────────────────┐    │
│  │                  WebSocket Server (ws library)                    │    │
│  │  - Accept client connections                                      │    │
│  │  - Route messages to appropriate handlers                         │    │
│  │  - Connection lifecycle management                                │    │
│  └────────────────────────────┬─────────────────────────────────────┘    │
│                                │                                           │
│  ┌────────────────────────────▼─────────────────────────────────────┐    │
│  │              Collaborative Server (Main Controller)               │    │
│  │  ┌──────────────────────────────────────────────────────────────┐ │   │
│  │  │  Rooms Map: sceneId → RoomManager                            │ │   │
│  │  └──────────────────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────────────────┐ │   │
│  │  │  Client Rooms Map: clientId → sceneId                        │ │   │
│  │  └──────────────────────────────────────────────────────────────┘ │   │
│  │  - Create/destroy rooms on demand                                 │   │
│  │  - Route messages to correct room                                 │   │
│  │  - Handle disconnections                                          │   │
│  └────────────────────────────┬─────────────────────────────────────┘    │
│                                │                                           │
│  ┌────────────────────────────▼─────────────────────────────────────┐    │
│  │                    Room Manager (per scene)                       │    │
│  │  ┌──────────────────────────────────────────────────────────────┐ │   │
│  │  │  Authoritative CRDT State                                    │ │   │
│  │  │  - Objects Map: objectId → CRDTObject                        │ │   │
│  │  │  - Vector Clock (merged from all clients)                    │ │   │
│  │  │  - Sequence Number (monotonically increasing)                │ │   │
│  │  └──────────────────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────────────────┐ │   │
│  │  │  Connected Clients                                           │ │   │
│  │  │  - clientId → {ws, presence}                                 │ │   │
│  │  │  - Presence: cursor position, selected objects, color        │ │   │
│  │  └──────────────────────────────────────────────────────────────┘ │   │
│  │  ┌──────────────────────────────────────────────────────────────┐ │   │
│  │  │  Operation Log (ring buffer, max 1000)                       │ │   │
│  │  │  - Recent operations for late joiners                        │ │   │
│  │  │  - Includes seqNum for ordering                              │ │   │
│  │  └──────────────────────────────────────────────────────────────┘ │   │
│  │                                                                    │   │
│  │  Core Functions:                                                  │   │
│  │  - handleCreate(): Add new object to scene                       │   │
│  │  - handleDelete(): Soft-delete (tombstone) object                │   │
│  │  - handleTransform(): Update position/rotation/scale             │   │
│  │  - handleMetadata(): Update color/name/properties                │   │
│  │  - broadcast(): Send operation to all clients except sender      │   │
│  │  - getSnapshot(): Generate full state for late joiners           │   │
│  │  - updatePresence(): Track user cursors and selections           │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘


┌────────────────────────────────────────────────────────────────────────────┐
│                     FUTURE: SCALING ARCHITECTURE                           │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                     │
│  │  WS Gateway  │  │  WS Gateway  │  │  WS Gateway  │                     │
│  │   (Server 1) │  │   (Server 2) │  │   (Server 3) │                     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                     │
│         │                  │                  │                             │
│         │    ┌─────────────┴─────────────┐   │                             │
│         │    │                             │   │                             │
│         ▼    ▼                             ▼   ▼                             │
│  ┌─────────────────────────────────────────────────┐                       │
│  │           Redis Pub/Sub (Message Broker)        │                       │
│  │  - Channel: scene:{sceneId}:operations          │                       │
│  │  - Channel: scene:{sceneId}:presence            │                       │
│  └─────────────────────────────────────────────────┘                       │
│         │                             │                                     │
│         ▼                             ▼                                     │
│  ┌──────────────┐              ┌──────────────┐                            │
│  │ Room Manager │              │ Room Manager │                            │
│  │  (Scene A)   │              │  (Scene B)   │                            │
│  └──────────────┘              └──────────────┘                            │
│         │                             │                                     │
│         ▼                             ▼                                     │
│  ┌─────────────────────────────────────────────────┐                       │
│  │              Redis Cache Layer                   │                       │
│  │  - Operation logs (TTL: 1 hour)                  │                       │
│  │  - Scene snapshots (TTL: 24 hours)               │                       │
│  │  - Presence data (TTL: 5 minutes)                │                       │
│  └─────────────────────────────────────────────────┘                       │
│         │                                                                   │
│         ▼                                                                   │
│  ┌─────────────────────────────────────────────────┐                       │
│  │           PostgreSQL (Persistence)               │                       │
│  │  - Scenes table (metadata, permissions)          │                       │
│  │  - Operations table (full history, audit)        │                       │
│  │  - Snapshots table (periodic checkpoints)        │                       │
│  └─────────────────────────────────────────────────┘                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. User Creates Object

```
┌─────────┐
│ User A  │
│ Browser │
└────┬────┘
     │ 1. Click "+ Cube"
     │
     ▼
┌──────────────────┐
│ Client.addCube() │
└────┬─────────────┘
     │ 2. Generate operation:
     │    {
     │      op: "create",
     │      objectId: "obj-123",
     │      timestamp: 1707408000123,
     │      vectorClock: {userA: 45}
     │    }
     │
     ├─────────────────────┐
     │ 3a. Optimistic:     │ 3b. Send to server
     │     Apply to local  │
     │     CRDT store      │
     │     Create mesh     │
     │     in Three.js     │
     └─────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ WebSocket   │
                    │ ws.send()   │
                    └──────┬──────┘
                           │
        ┌──────────────────┴──────────────────┐
        │         Server receives             │
        │    4. Room Manager processes        │
        │       - Increment seqNum            │
        │       - Update vector clock         │
        │       - Add to objects map          │
        │       - Add to operation log        │
        └──────────────────┬──────────────────┘
                           │
        ┌──────────────────┴──────────────────┐
        │    5. Broadcast to all clients      │
        │       except sender                 │
        └──────────────────┬──────────────────┘
                           │
     ┌─────────────────────┴─────────────────────┐
     │                                             │
     ▼                                             ▼
┌─────────┐                                  ┌─────────┐
│ User B  │                                  │ User C  │
│ Browser │                                  │ Browser │
└────┬────┘                                  └────┬────┘
     │ 6. Receive operation                       │
     │    Merge with local CRDT                   │
     │    Create mesh in Three.js                 │
     │    → Sees cube appear!                     │
     └────────────────────────────────────────────┘
```

### 2. Concurrent Edits (Conflict Resolution)

```
Time: t=1000

User A                              User B
  │                                   │
  │ 1. Move obj-123                   │ 1. Move obj-123
  │    to (5, 0, 0)                   │    to (0, 0, 5)
  │    t=1000                         │    t=1001
  │    VC={A:10}                      │    VC={B:10}
  │                                   │
  │ 2. Apply locally                  │ 2. Apply locally
  │    (optimistic)                   │    (optimistic)
  │                                   │
  ├──────────┐                        │
  │          │ 3. Send to server      │
  │          ▼                        │
  │    ┌──────────┐                   │
  │    │  Server  │                   │
  │    │  seqNum  │                   │
  │    │   1523   │                   │
  │    └────┬─────┘                   │
  │         │                         │
  │         │ 4. Broadcast            ├──────────┐
  │         ▼                         │          │
  │    Receives B's op                │          │ 3. Send to server
  │    t=1001, VC={B:10}              │          ▼
  │                                   │    ┌──────────┐
  │ 5. CRDT Merge:                    │    │  Server  │
  │    Compare VC:                    │    │  seqNum  │
  │    {A:10} vs {B:10}               │    │   1524   │
  │    → Concurrent!                  │    └────┬─────┘
  │    Compare timestamps:            │         │
  │    1000 vs 1001                   │         │ 4. Broadcast
  │    → B wins (higher t)            │         ▼
  │                                   │    Receives A's op
  │ 6. Update local:                  │    t=1000, VC={A:10}
  │    position = (0, 0, 5)           │
  │    (A's change is rolled back)    │ 5. CRDT Merge:
  │                                   │    Same logic
  │                                   │    → B wins
  │                                   │
  │ Result: Both see (0, 0, 5)        │ 6. No change needed
  │                                   │    (already at B's value)
  │                                   │
  └───────────────────────────────────┴───────────────────────
                  Final state: position = (0, 0, 5)
```

### 3. Late Joiner Flow

```
┌─────────┐
│ User C  │
│ Joins   │
└────┬────┘
     │ 1. Connect WebSocket
     │
     ▼
┌──────────────────┐
│ ws.send({        │
│   type: "join",  │
│   sceneId: "xyz",│
│   clientId: "C"  │
│ })               │
└────┬─────────────┘
     │
     ▼
┌─────────────────────────────────────────┐
│ Server - Room Manager                   │
│                                         │
│ 2. Generate snapshot:                   │
│    snapshot = {                         │
│      objects: {                         │
│        "obj-1": {full state},           │
│        "obj-2": {full state},           │
│        ...                              │
│      },                                 │
│      presence: [                        │
│        {clientId: "A", cursor: ...},    │
│        {clientId: "B", cursor: ...}     │
│      ],                                 │
│      vectorClock: {A: 50, B: 45},       │
│      lastSeqNum: 1524                   │
│    }                                    │
│                                         │
│ 3. Add C to clients map                 │
│                                         │
└────┬────────────────────────────────────┘
     │
     │ 4. Send snapshot to C
     │
     ▼
┌─────────────────────────────────────────┐
│ User C - Client                         │
│                                         │
│ 5. Receive snapshot                     │
│                                         │
│ 6. Initialize local CRDT:               │
│    - Create all objects                 │
│    - Set vector clock = {A:50, B:45}    │
│    - Create all meshes in Three.js      │
│                                         │
│ 7. Start receiving real-time ops       │
│    (seqNum > 1524)                      │
│                                         │
└─────────────────────────────────────────┘
```

## CRDT Conflict Resolution Algorithm

```python
def merge_lww_register(local, remote):
    """
    Merge two LWW-Register values
    
    Returns: True if local should be updated, False otherwise
    """
    
    # Step 1: Compare vector clocks (causal ordering)
    vc_comparison = compare_vector_clocks(local.vc, remote.vc)
    
    if vc_comparison > 0:
        # Local is causally newer - ignore remote
        return False
        
    elif vc_comparison < 0:
        # Remote is causally newer - accept remote
        local.value = remote.value
        local.timestamp = remote.timestamp
        local.clientId = remote.clientId
        local.vc = merge_vector_clocks(local.vc, remote.vc)
        return True
        
    else:  # vc_comparison == None (concurrent)
        # Step 2: Use timestamp for tie-breaking
        
        if remote.timestamp > local.timestamp:
            # Remote has higher timestamp - accept
            local.value = remote.value
            local.timestamp = remote.timestamp
            local.clientId = remote.clientId
            local.vc = merge_vector_clocks(local.vc, remote.vc)
            return True
            
        elif remote.timestamp == local.timestamp:
            # Step 3: Deterministic tie-break with clientId
            
            if remote.clientId > local.clientId:  # Lexicographic
                local.value = remote.value
                local.clientId = remote.clientId
                local.vc = merge_vector_clocks(local.vc, remote.vc)
                return True
        
        # In all other cases, local wins
        # But still merge vector clocks
        local.vc = merge_vector_clocks(local.vc, remote.vc)
        return False


def compare_vector_clocks(vc1, vc2):
    """
    Compare two vector clocks
    
    Returns:
        1 if vc1 > vc2 (vc1 causally dominates)
       -1 if vc1 < vc2 (vc2 causally dominates)
        0 if vc1 == vc2 (equal)
        None if concurrent
    """
    has_greater = False
    has_less = False
    
    all_clients = set(vc1.keys()) | set(vc2.keys())
    
    for client in all_clients:
        val1 = vc1.get(client, 0)
        val2 = vc2.get(client, 0)
        
        if val1 > val2:
            has_greater = True
        if val1 < val2:
            has_less = True
    
    if has_greater and has_less:
        return None  # Concurrent
    elif has_greater:
        return 1     # vc1 dominates
    elif has_less:
        return -1    # vc2 dominates
    else:
        return 0     # Equal
```

## Message Protocol Specification

### Client → Server Messages

#### 1. JOIN
```json
{
  "type": "join",
  "sceneId": "scene-xyz",
  "clientId": "user-abc-123",
  "vectorClock": {}
}
```

#### 2. CREATE
```json
{
  "type": "operation",
  "op": "create",
  "sceneId": "scene-xyz",
  "objectId": "obj-456",
  "objectData": {
    "type": "mesh",
    "geometry": "sphere",
    "transform": {
      "position": { "value": { "x": 0, "y": 0.5, "z": 0 } },
      "rotation": { "value": { "x": 0, "y": 0, "z": 0, "w": 1 } },
      "scale": { "value": { "x": 1, "y": 1, "z": 1 } }
    },
    "metadata": {
      "color": { "value": "#FF5733" },
      "name": { "value": "Sphere 1" }
    }
  },
  "timestamp": 1707408000200,
  "clientId": "user-abc-123",
  "vectorClock": { "user-abc-123": 46 }
}
```

#### 3. TRANSFORM
```json
{
  "type": "operation",
  "op": "transform",
  "sceneId": "scene-xyz",
  "objectId": "obj-456",
  "property": "position",
  "value": { "x": 5.0, "y": 2.0, "z": -3.0 },
  "timestamp": 1707408000300,
  "clientId": "user-abc-123",
  "vectorClock": { "user-abc-123": 47, "user-def-456": 32 }
}
```

#### 4. DELETE
```json
{
  "type": "operation",
  "op": "delete",
  "sceneId": "scene-xyz",
  "objectId": "obj-456",
  "timestamp": 1707408000400,
  "clientId": "user-abc-123",
  "vectorClock": { "user-abc-123": 48 }
}
```

#### 5. PRESENCE
```json
{
  "type": "presence",
  "sceneId": "scene-xyz",
  "clientId": "user-abc-123",
  "cursor": { "x": 250, "y": 180 },
  "selectedObjects": ["obj-456"]
}
```

### Server → Client Messages

#### 1. SNAPSHOT (on join)
```json
{
  "type": "snapshot",
  "sceneId": "scene-xyz",
  "objects": {
    "obj-123": {
      "id": "obj-123",
      "type": "mesh",
      "geometry": "box",
      "transform": {
        "position": {
          "value": { "x": 0, "y": 0, "z": 0 },
          "timestamp": 1707408000100,
          "clientId": "user-abc-123",
          "vectorClock": { "user-abc-123": 45 }
        },
        ...
      },
      ...
    }
  },
  "presence": [
    {
      "clientId": "user-abc-123",
      "cursor": { "x": 100, "y": 200 },
      "selectedObjects": [],
      "color": "#FF6B6B"
    }
  ],
  "vectorClock": { "user-abc-123": 45, "user-def-456": 32 },
  "lastSeqNum": 1524,
  "timestamp": 1707408000500
}
```

#### 2. OPERATION (broadcast)
```json
{
  "type": "operation",
  "op": "transform",
  "sceneId": "scene-xyz",
  "objectId": "obj-456",
  "property": "position",
  "value": { "x": 5.0, "y": 2.0, "z": -3.0 },
  "timestamp": 1707408000300,
  "clientId": "user-abc-123",
  "vectorClock": { "user-abc-123": 47, "user-def-456": 32 },
  "seqNum": 1525,
  "serverTimestamp": 1707408000302
}
```

This architecture provides a solid foundation for real-time collaborative 3D editing with conflict-free operations!
