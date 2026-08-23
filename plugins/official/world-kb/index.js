export default function register(api) {
  api.registerTool({
    name: 'scan_new_worlds',
    description: "[action] Scan VRChat for worlds created in the last N days, filter junk, write to the world_kb table, and return a recommended list. dryRun=true only reports without writing.",
    inputSchema: {
      "type": "object",
      "properties": {
        "days": {
          "type": "number",
          "default": 7,
          "description": "Lookback window in days (1-30, default 7)"
        },
        "dryRun": {
          "type": "boolean",
          "default": false,
          "description": "Report only, do not write to DB"
        }
      }
    },
    handler: async (args) => api.consume('world.scanNewWorlds', args)
  });

  api.registerTool({
    name: 'get_new_worlds',
    description: "[query] Query tracked new worlds from the world_kb table (read-only). Filter by visited, sort by heat, limit count.",
    inputSchema: {
      "type": "object",
      "properties": {
        "onlyUnvisited": {
          "type": "boolean",
          "default": false,
          "description": "Only return worlds the user has not visited"
        },
        "limit": {
          "type": "number",
          "default": 10,
          "description": "Max rows (1-50, default 10)"
        },
        "sortBy": {
          "type": "string",
          "enum": [
            "favorites",
            "occupants",
            "popularity",
            "created_at"
          ],
          "default": "favorites",
          "description": "Sort field (descending)"
        },
        "excludeTheme": {
          "type": "string",
          "description": "Comma-separated theme keywords to exclude (matched against author tags, e.g. \"game,horror,dance\")"
        }
      }
    },
    handler: async (args) => api.consume('world.getNewWorlds', args)
  });

  api.registerTool({
    name: 'rate_world',
    description: "[action] Rate a world as good/junk for recommendation feedback (Issue #19). rating=1 good (weighted up), -1 junk (weighted down/excluded), 0 clear.",
    inputSchema: {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "rating": {
          "type": "number",
          "enum": [
            -1,
            0,
            1
          ],
          "description": "-1=junk, 0=clear, 1=good"
        }
      },
      "required": [
        "worldId",
        "rating"
      ]
    },
    handler: async (args) => api.consume('world.rateWorld', args)
  });

  api.registerTool({
    name: 'mark_world_visited',
    description: "[action] Explicitly mark a world as visited (Issue #19: event-driven visited can miss). Useful to close the recommend-open-browse loop.",
    inputSchema: {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => api.consume('world.markWorldVisited', args)
  });

  api.registerTool({
    name: 'set_world_sleep',
    description: "[action] Manually mark a world as a sleep-friendly map (sets sleep_ok=1, a strong signal in recommend_join/recommend_worlds). isSleep=false clears the marker. Local-only.",
    inputSchema: {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "isSleep": {
          "type": "boolean",
          "default": true,
          "description": "true=mark as sleep map, false=clear"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => api.consume('world.setWorldSleep', args)
  });

  api.registerTool({
    name: 'add_to_backlog',
    description: "[action] Add a world to your local to-visit backlog (待逛列表). Worlds stay pending until visited (auto-cleared by location events) or manually removed. Idempotent: re-adding updates reason/priority. Local-only, does not touch VRChat cloud favorites.",
    inputSchema: {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        },
        "reason": {
          "type": "string",
          "description": "Why you want to visit (e.g. 氛围图/解谜/温泉/带人逛)"
        },
        "priority": {
          "type": "number",
          "enum": [
            0,
            1,
            2
          ],
          "default": 0,
          "description": "0=normal, 1=high, 2=must visit"
        }
      },
      "required": [
        "worldId"
      ]
    },
    handler: async (args) => api.consume('world.addToBacklog', args)
  });

  api.registerTool({
    name: 'get_backlog',
    description: "[query] List worlds in your local to-visit backlog (待逛列表). status=pending (default) shows unvisited to-visit worlds; visited shows the ones already visited (they leave the pending view automatically once visited); all shows both. Each item carries snapshot details (favorites/tags/description) from the local world knowledge table.",
    inputSchema: {
      "type": "object",
      "properties": {
        "status": {
          "type": "string",
          "enum": [
            "pending",
            "visited",
            "all"
          ],
          "default": "pending",
          "description": "pending=未逛, visited=逛完历史, all=全部"
        },
        "sortBy": {
          "type": "string",
          "enum": [
            "added_at",
            "priority",
            "favorites"
          ],
          "default": "added_at",
          "description": "Sort field (descending)"
        },
        "limit": {
          "type": "number",
          "default": 20,
          "description": "Max rows (1-50, default 20)"
        }
      }
    },
    handler: async (args) => api.consume('world.getBacklog', args)
  });

  api.registerTool({
    name: 'remove_from_backlog',
    description: "[action] Remove a world from the to-visit backlog (待逛列表). Local-only, does not affect cloud favorites. Idempotent.",
    inputSchema: {
      "type": "object",
      "properties": {
        "worldId": {
          "type": "string",
          "description": "VRChat world ID (wrld_...)"
        }
      },
      "required": [
        "worldId"
      ]
    },
    destructive: true,
    handler: async (args) => api.consume('world.removeFromBacklog', args)
  });

  api.registerTool({
    name: 'search_worlds',
    description: "[query] Search VRChat worlds by name. English/Japanese search the live API; Chinese keywords fall back to local cache (API CJK search is unreliable).",
    inputSchema: {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "World name keyword (Chinese/English/Japanese)"
        },
        "n": {
          "type": "number",
          "description": "Max API results (default 10, max 30)"
        }
      },
      "required": [
        "query"
      ]
    },
    handler: async (args) => api.consume('world.searchWorlds', args)
  });
}
