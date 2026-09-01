/**
 * VRChat 好友监控系统 — 好友状态管理（内存缓存）
 * 
 * 在内存中维护好友在线状态，O(1) 查询
 */
export class FriendStateManager {
  constructor() {
    this._online = new Set();    // Set<userId>
    this._locations = new Map(); // Map<userId, {location, worldId, worldName, displayName}>
    this._notifyListeners = [];
  }

  /** 好友上线 */
  setOnline(userId, info = {}) {
    this._online.add(userId);
    if (info.location || info.displayName) {
      this._locations.set(userId, {
        location: info.location || '',
        worldId: info.worldId || '',
        worldName: info.worldName || '',
        displayName: info.displayName || '',
        updatedAt: new Date().toISOString(),
      });
    }
    this._notify('online', userId, info);
  }

  /** 好友离线 */
  setOffline(userId) {
    this._online.delete(userId);
    this._notify('offline', userId);
  }

  /** 更新位置 */
  updateLocation(userId, info) {
    if (this._online.has(userId)) {
      this._locations.set(userId, {
        ...(this._locations.get(userId) || {}),
        location: info.location || '',
        worldId: info.worldId || '',
        worldName: info.worldName || '',
        displayName: info.displayName || '',
        updatedAt: new Date().toISOString(),
      });
    }
    this._notify('location', userId, info);
  }

  /** 判断是否在线 */
  isOnline(userId) {
    return this._online.has(userId);
  }

  /** 获取在线好友列表 */
  getOnlineFriends() {
    return [...this._online].map(id => ({
      userId: id,
      ...(this._locations.get(id) || {}),
    }));
  }

  /** 获取在线好友数量 */
  getOnlineCount() {
    return this._online.size;
  }

  /** 获取好友位置信息 */
  getFriendLocation(userId) {
    return this._locations.get(userId) || null;
  }

  /** 批量设置在线状态（重连后全量刷新） */
  batchSetOnline(users) {
    this._online.clear();
    this._locations.clear();
    for (const u of users) {
      if (u.isOnline) {
        this._online.add(u.userId);
        if (u.location) {
          this._locations.set(u.userId, {
            location: u.location,
            worldId: u.worldId || '',
            worldName: u.worldName || '',
            displayName: u.displayName || '',
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  /** 添加状态变化监听 */
  onChange(callback) {
    this._notifyListeners.push(callback);
    return () => {
      this._notifyListeners = this._notifyListeners.filter(c => c !== callback);
    };
  }

  _notify(type, userId, info = {}) {
    for (const cb of this._notifyListeners) {
      try { cb({ type, userId, ...info }); } catch {}
    }
  }

  /** 获取调试统计 */
  getStats() {
    return {
      online: this._online.size,
      tracked: this._locations.size,
    };
  }
}
