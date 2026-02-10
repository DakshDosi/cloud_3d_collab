/**
 * Shared types and utilities for CRDT-based collaborative 3D editing
 * Client-side version
 */

// Generate unique IDs
export function generateId(prefix = 'id') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Vector Clock implementation
export class VectorClock {
  constructor(clock = {}) {
    this.clock = { ...clock };
  }

  increment(clientId) {
    this.clock[clientId] = (this.clock[clientId] || 0) + 1;
  }

  update(clientId, value) {
    this.clock[clientId] = value;
  }

  merge(other) {
    const merged = new VectorClock(this.clock);
    for (const [clientId, value] of Object.entries(other.clock)) {
      merged.clock[clientId] = Math.max(merged.clock[clientId] || 0, value);
    }
    return merged;
  }

  compare(other) {
    let hasGreater = false;
    let hasLess = false;

    const allClients = new Set([
      ...Object.keys(this.clock),
      ...Object.keys(other.clock)
    ]);

    for (const clientId of allClients) {
      const thisVal = this.clock[clientId] || 0;
      const otherVal = other.clock[clientId] || 0;

      if (thisVal > otherVal) hasGreater = true;
      if (thisVal < otherVal) hasLess = true;
    }

    // Both have greater values on different keys = concurrent
    if (hasGreater && hasLess) return null; // concurrent
    // This has all greater or equal values = this dominates
    if (hasGreater && !hasLess) return 1;  // this > other
    // Other has all greater or equal values = other dominates
    if (hasLess && !hasGreater) return -1; // this < other
    // All equal
    return 0; // equal
  }

  toJSON() {
    return this.clock;
  }

  static fromJSON(json) {
    return new VectorClock(json);
  }
}

// LWW-Register (Last-Write-Wins Register)
export class LWWRegister {
  constructor(value = null, timestamp = 0, clientId = null, vectorClock = new VectorClock()) {
    this.value = value;
    this.timestamp = timestamp;
    this.clientId = clientId;
    this.vectorClock = vectorClock;
  }

  set(value, timestamp, clientId, vectorClock) {
    this.value = value;
    this.timestamp = timestamp;
    this.clientId = clientId;
    this.vectorClock = vectorClock;
  }

  merge(other) {
    const comparison = this.vectorClock.compare(other.vectorClock);

    if (comparison === 1) {
      // This is causally newer
      return;
    } else if (comparison === -1) {
      // Other is causally newer
      this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
    } else {
      // Concurrent - use timestamp
      if (other.timestamp > this.timestamp) {
        this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
      } else if (other.timestamp === this.timestamp) {
        // Tie-break with clientId (deterministic)
        if (other.clientId > this.clientId) {
          this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
        }
      }
      // Merge vector clocks regardless
      this.vectorClock = this.vectorClock.merge(other.vectorClock);
    }
  }

  toJSON() {
    return {
      value: this.value,
      timestamp: this.timestamp,
      clientId: this.clientId,
      vectorClock: this.vectorClock.toJSON()
    };
  }

  static fromJSON(json) {
    return new LWWRegister(
      json.value,
      json.timestamp,
      json.clientId,
      VectorClock.fromJSON(json.vectorClock)
    );
  }
}

// 3D Object representation
export class CRDTObject {
  constructor(id, type = 'mesh', geometry = 'box') {
    this.id = id;
    this.type = type;
    this.geometry = geometry;
    
    const now = Date.now();
    const vc = new VectorClock();
    
    this.transform = {
      position: new LWWRegister({ x: 0, y: 0, z: 0 }, now, null, vc),
      rotation: new LWWRegister({ x: 0, y: 0, z: 0, w: 1 }, now, null, vc),
      scale: new LWWRegister({ x: 1, y: 1, z: 1 }, now, null, vc)
    };
    
    this.metadata = {
      color: new LWWRegister('#' + Math.floor(Math.random()*16777215).toString(16), now, null, vc),
      name: new LWWRegister('Object', now, null, vc)
    };
    
    this.createdBy = null;
    this.createdAt = now;
    this.tombstone = null; // For soft deletion
  }

  updateProperty(property, value, timestamp, clientId, vectorClock) {
    const keys = property.split('.');
    let target = this;
    
    for (let i = 0; i < keys.length - 1; i++) {
      target = target[keys[i]];
    }
    
    const lastKey = keys[keys.length - 1];
    if (target[lastKey] instanceof LWWRegister) {
      target[lastKey].merge(new LWWRegister(value, timestamp, clientId, vectorClock));
    }
  }

  delete(timestamp, clientId, vectorClock) {
    this.tombstone = { timestamp, clientId, vectorClock };
  }

  isDeleted() {
    return this.tombstone !== null;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      geometry: this.geometry,
      transform: {
        position: this.transform.position.toJSON(),
        rotation: this.transform.rotation.toJSON(),
        scale: this.transform.scale.toJSON()
      },
      metadata: {
        color: this.metadata.color.toJSON(),
        name: this.metadata.name.toJSON()
      },
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      tombstone: this.tombstone
    };
  }

  static fromJSON(json) {
    const obj = new CRDTObject(json.id, json.type, json.geometry);
    obj.transform.position = LWWRegister.fromJSON(json.transform.position);
    obj.transform.rotation = LWWRegister.fromJSON(json.transform.rotation);
    obj.transform.scale = LWWRegister.fromJSON(json.transform.scale);
    obj.metadata.color = LWWRegister.fromJSON(json.metadata.color);
    obj.metadata.name = LWWRegister.fromJSON(json.metadata.name);
    obj.createdBy = json.createdBy;
    obj.createdAt = json.createdAt;
    obj.tombstone = json.tombstone;
    return obj;
  }
}

// Operation types
export const OperationType = {
  TRANSFORM: 'transform',
  CREATE: 'create',
  DELETE: 'delete',
  METADATA: 'metadata'
};

export const MessageType = {
  OPERATION: 'operation',
  SNAPSHOT: 'snapshot',
  JOIN: 'join',
  PRESENCE: 'presence',
  PING: 'ping',
  PONG: 'pong'
};
