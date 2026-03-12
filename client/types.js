/**
 * Shared types and utilities for CRDT-based collaborative 3D editing
 * Includes State-Snapshot Versioning
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

    if (hasGreater && hasLess) return null; // concurrent
    if (hasGreater && !hasLess) return 1;  // this > other
    if (hasLess && !hasGreater) return -1; // this < other
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
      return;
    } else if (comparison === -1) {
      this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
    } else {
      if (other.timestamp > this.timestamp) {
        this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
      } else if (other.timestamp === this.timestamp) {
        if (other.clientId > this.clientId) {
          this.set(other.value, other.timestamp, other.clientId, other.vectorClock);
        }
      }
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

// Object Version Snapshot
export class ObjectVersion {
  constructor(versionId, snapshot, metadata = {}) {
    this.versionId = versionId;
    this.timestamp = Date.now();
    this.snapshot = snapshot;
    this.saveType = metadata.saveType || 'auto'; // 'auto', 'manual', 'checkpoint'
    this.savedBy = metadata.savedBy || null;
    this.label = metadata.label || null;
    this.tags = metadata.tags || [];
    this.changesSummary = metadata.changesSummary || null;
  }

  toJSON() {
    return {
      versionId: this.versionId,
      timestamp: this.timestamp,
      snapshot: this.snapshot,
      saveType: this.saveType,
      savedBy: this.savedBy,
      label: this.label,
      tags: this.tags,
      changesSummary: this.changesSummary
    };
  }

  static fromJSON(json) {
    const version = new ObjectVersion(json.versionId, json.snapshot, {
      saveType: json.saveType,
      savedBy: json.savedBy,
      label: json.label,
      tags: json.tags,
      changesSummary: json.changesSummary
    });
    version.timestamp = json.timestamp;
    return version;
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
    this.tombstone = null;
    
    // Version history
    this.versionHistory = {
      enabled: true,
      maxVersions: 50,
      versions: [],
      currentVersionId: null,
      autoSaveInterval: 30000 // 30 seconds
    };
    
    // Create initial version
    this.saveVersion('manual', 'Initial creation');
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

  // Save current state as version
  saveVersion(saveType = 'auto', label = null, tags = []) {
    const versionId = generateId('v');
    
    const snapshot = {
      transform: {
        position: { ...this.transform.position.toJSON() },
        rotation: { ...this.transform.rotation.toJSON() },
        scale: { ...this.transform.scale.toJSON() }
      },
      metadata: {
        color: { ...this.metadata.color.toJSON() },
        name: { ...this.metadata.name.toJSON() }
      }
    };

    const changesSummary = this.calculateChanges();

    const version = new ObjectVersion(versionId, snapshot, {
      saveType,
      savedBy: this.createdBy,
      label,
      tags,
      changesSummary
    });

    this.versionHistory.versions.push(version);
    this.versionHistory.currentVersionId = versionId;

    // Limit versions
    if (this.versionHistory.versions.length > this.versionHistory.maxVersions) {
      this.versionHistory.versions.shift();
    }

    return version;
  }

  // Calculate what changed from previous version
  calculateChanges() {
    if (this.versionHistory.versions.length === 0) {
      return { modified: ['all'], delta: {} };
    }

    const previous = this.versionHistory.versions[this.versionHistory.versions.length - 1];
    const changes = { modified: [], delta: {} };

    // Check position
    const prevPos = previous.snapshot.transform.position.value;
    const currPos = this.transform.position.value;
    if (JSON.stringify(prevPos) !== JSON.stringify(currPos)) {
      changes.modified.push('transform.position');
      changes.delta.position = { from: prevPos, to: currPos };
    }

    // Check rotation
    const prevRot = previous.snapshot.transform.rotation.value;
    const currRot = this.transform.rotation.value;
    if (JSON.stringify(prevRot) !== JSON.stringify(currRot)) {
      changes.modified.push('transform.rotation');
      changes.delta.rotation = { from: prevRot, to: currRot };
    }

    // Check scale
    const prevScale = previous.snapshot.transform.scale.value;
    const currScale = this.transform.scale.value;
    if (JSON.stringify(prevScale) !== JSON.stringify(currScale)) {
      changes.modified.push('transform.scale');
      changes.delta.scale = { from: prevScale, to: currScale };
    }

    // Check color
    if (previous.snapshot.metadata.color.value !== this.metadata.color.value) {
      changes.modified.push('metadata.color');
      changes.delta.color = {
        from: previous.snapshot.metadata.color.value,
        to: this.metadata.color.value
      };
    }

    return changes;
  }

  // Restore to a specific version
  restoreVersion(versionId) {
    const version = this.versionHistory.versions.find(v => v.versionId === versionId);
    if (!version) {
      throw new Error(`Version ${versionId} not found`);
    }

    // Save current state before restoring
    this.saveVersion('checkpoint', `Before restoring to ${versionId}`);

    // Restore snapshot
    const snapshot = version.snapshot;
    
    this.transform.position.value = { ...snapshot.transform.position.value };
    this.transform.rotation.value = { ...snapshot.transform.rotation.value };
    this.transform.scale.value = { ...snapshot.transform.scale.value };
    this.metadata.color.value = snapshot.metadata.color.value;
    this.metadata.name.value = snapshot.metadata.name.value;

    // Update timestamps
    const now = Date.now();
    this.transform.position.timestamp = now;
    this.transform.rotation.timestamp = now;
    this.transform.scale.timestamp = now;
    this.metadata.color.timestamp = now;
    this.metadata.name.timestamp = now;

    this.versionHistory.currentVersionId = versionId;

    return version;
  }

  // Get version by ID
  getVersion(versionId) {
    return this.versionHistory.versions.find(v => v.versionId === versionId);
  }

  // Get all versions
  getVersionList() {
    return this.versionHistory.versions.map(v => ({
      versionId: v.versionId,
      timestamp: v.timestamp,
      saveType: v.saveType,
      label: v.label,
      tags: v.tags,
      changesSummary: v.changesSummary
    }));
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
      tombstone: this.tombstone,
      versionHistory: {
        ...this.versionHistory,
        versions: this.versionHistory.versions.map(v => v.toJSON())
      }
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
    
    // Restore version history
    if (json.versionHistory) {
      obj.versionHistory = {
        ...json.versionHistory,
        versions: json.versionHistory.versions.map(v => ObjectVersion.fromJSON(v))
      };
    }
    
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

// Message types
export const MessageType = {
  OPERATION: 'operation',
  SNAPSHOT: 'snapshot',
  JOIN: 'join',
  PRESENCE: 'presence',
  PING: 'ping',
  PONG: 'pong',
  VERSION_SAVE: 'version_save',
  VERSION_RESTORE: 'version_restore',
  VERSION_LIST: 'version_list',
  VERSION_RESPONSE: 'version_response'
};