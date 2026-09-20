                         ┌──────────────────────────────┐
                         │       WEBSOCKET SERVER       │
                         │                              │
                         │          index.ts            │
                         └──────────────┬───────────────┘
                                        │
                           connection event
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
              ┌──────────┐        ┌──────────┐        ┌──────────┐
              │ Client A │        │ Client B │        │ Client C │
              └────┬─────┘        └────┬─────┘        └────┬─────┘
                   │                   │                   │
              WebSocket A         WebSocket B         WebSocket C
                   │                   │                   │
                   ▼                   ▼                   ▼
             ┌──────────┐        ┌──────────┐        ┌──────────┐
             │  User A  │        │  User B  │        │  User C  │
             │ instance │        │ instance │        │ instance │
             └────┬─────┘        └────┬─────┘        └────┬─────┘
                  │                   │                   │
                  │ initHandlers()    │                   │
                  ▼                   ▼                   ▼
             on("message")       on("message")       on("message")
                  │                   │                   │
                  └───────────────────┼───────────────────┘
                                      │
                                      ▼
                         ┌────────────────────────┐
                         │     RoomManager        │
                         │                        │
                         │    SINGLE INSTANCE    │
                         │                        │
                         │   Manages all rooms    │
                         │   Manages all users    │
                         │   Broadcasts messages  │
                         └────────────┬───────────┘
                                      │
                     ┌────────────────┴────────────────┐
                     │                                 │
                     ▼                                 ▼
                ┌──────────┐                      ┌──────────┐
                │  room 1  │                      │  room 2  │
                ├──────────┤                      ├──────────┤
                │ User A   │                      │ User D   │
                │ User B   │                      │ User E   │
                │ User C   │                      └──────────┘
                └──────────┘