module.exports = [
"[project]/components/Room.tsx [ssr] (ecmascript)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

__turbopack_context__.s([
    "default",
    ()=>Room
]);
var __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/react/jsx-dev-runtime [external] (react/jsx-dev-runtime, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__ = __turbopack_context__.i("[externals]/react [external] (react, cjs)");
var __TURBOPACK__imported__module__$5b$externals$5d2f$socket$2e$io$2d$client__$5b$external$5d$__$28$socket$2e$io$2d$client$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$29$__ = __turbopack_context__.i("[externals]/socket.io-client [external] (socket.io-client, esm_import, [project]/node_modules/socket.io-client)");
var __turbopack_async_dependencies__ = __turbopack_handle_async_dependencies__([
    __TURBOPACK__imported__module__$5b$externals$5d2f$socket$2e$io$2d$client__$5b$external$5d$__$28$socket$2e$io$2d$client$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$29$__
]);
[__TURBOPACK__imported__module__$5b$externals$5d2f$socket$2e$io$2d$client__$5b$external$5d$__$28$socket$2e$io$2d$client$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$29$__] = __turbopack_async_dependencies__.then ? (await __turbopack_async_dependencies__)() : __turbopack_async_dependencies__;
;
;
;
// Socket.io クライアントを初期化（WebSocketで接続）
const socket = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$socket$2e$io$2d$client__$5b$external$5d$__$28$socket$2e$io$2d$client$2c$__esm_import$2c$__$5b$project$5d2f$node_modules$2f$socket$2e$io$2d$client$29$__["default"])('/', {
    path: '/socket.io',
    transports: [
        'websocket'
    ]
});
function Room() {
    // 状態管理：部屋一覧
    const [rooms, setRooms] = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useState"])([]);
    // 選択中の部屋ID
    const [selectedRoom, setSelectedRoom] = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useState"])(null);
    // 選択中の部屋にいるプレイヤー一覧
    const [roomPlayers, setRoomPlayers] = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useState"])([]);
    // 入力されたプレイヤー名
    const [name, setName] = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useState"])('');
    // 入室済みの部屋ID（入室済みかどうかを判定するため）
    const [joinedRoom, setJoinedRoom] = (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useState"])(null);
    // 初回マウント時にSocket.ioのイベントを設定
    (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react__$5b$external$5d$__$28$react$2c$__cjs$29$__["useEffect"])(()=>{
        socket.on('connect', ()=>{
            console.log('✅ Socket.io 接続成功:', socket.id);
        });
        socket.on('roomList', (list)=>{
            console.log('📦 受け取った部屋一覧:', list);
            setRooms(list);
        });
        socket.on('lobbyUpdate', (players)=>{
            setRoomPlayers(players);
        });
        return ()=>{
            socket.disconnect();
        };
    }, []);
    // 部屋をクリックしたときの処理
    const handleSelectRoom = (roomId)=>{
        setSelectedRoom(roomId); // 選択状態を更新
        socket.emit('getRoomPlayers', roomId); // サーバーにプレイヤー一覧をリクエスト
    };
    // 入室ボタンを押したときの処理
    const handleJoin = ()=>{
        if (selectedRoom && name.trim()) {
            socket.emit('joinRoom', {
                roomId: selectedRoom,
                name
            }); // サーバーに入室リクエスト
            setJoinedRoom(selectedRoom); // 入室状態を更新
        }
    };
    return /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("div", {
        style: styles.container,
        children: [
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("div", {
                style: styles.roomList,
                children: [
                    /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("h2", {
                        children: "🗂️ 部屋一覧"
                    }, void 0, false, {
                        fileName: "[project]/components/Room.tsx",
                        lineNumber: 66,
                        columnNumber: 9
                    }, this),
                    rooms.map((room)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("div", {
                            style: {
                                ...styles.roomItem,
                                backgroundColor: selectedRoom === room.id ? '#1f2a2f' : '#1e1e1e'
                            },
                            onClick: ()=>handleSelectRoom(room.id),
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("strong", {
                                    children: room.id
                                }, void 0, false, {
                                    fileName: "[project]/components/Room.tsx",
                                    lineNumber: 76,
                                    columnNumber: 13
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("span", {
                                    children: [
                                        room.count,
                                        "人"
                                    ]
                                }, void 0, true, {
                                    fileName: "[project]/components/Room.tsx",
                                    lineNumber: 77,
                                    columnNumber: 13
                                }, this)
                            ]
                        }, room.id, true, {
                            fileName: "[project]/components/Room.tsx",
                            lineNumber: 68,
                            columnNumber: 11
                        }, this))
                ]
            }, void 0, true, {
                fileName: "[project]/components/Room.tsx",
                lineNumber: 65,
                columnNumber: 7
            }, this),
            /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("div", {
                style: styles.roomDetail,
                children: selectedRoom ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["Fragment"], {
                    children: [
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("h2", {
                            children: [
                                "🏠 ",
                                selectedRoom
                            ]
                        }, void 0, true, {
                            fileName: "[project]/components/Room.tsx",
                            lineNumber: 86,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("p", {
                            children: "現在の参加者："
                        }, void 0, false, {
                            fileName: "[project]/components/Room.tsx",
                            lineNumber: 87,
                            columnNumber: 13
                        }, this),
                        /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("ul", {
                            children: roomPlayers.map((p, i)=>/*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("li", {
                                    children: p
                                }, i, false, {
                                    fileName: "[project]/components/Room.tsx",
                                    lineNumber: 90,
                                    columnNumber: 17
                                }, this))
                        }, void 0, false, {
                            fileName: "[project]/components/Room.tsx",
                            lineNumber: 88,
                            columnNumber: 13
                        }, this),
                        joinedRoom === selectedRoom ? /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("p", {
                            style: {
                                color: '#00ffcc'
                            },
                            children: "✅ 入室済み"
                        }, void 0, false, {
                            fileName: "[project]/components/Room.tsx",
                            lineNumber: 96,
                            columnNumber: 15
                        }, this) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])(__TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["Fragment"], {
                            children: [
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("input", {
                                    type: "text",
                                    placeholder: "名前を入力",
                                    value: name,
                                    onChange: (e)=>setName(e.target.value),
                                    style: styles.input
                                }, void 0, false, {
                                    fileName: "[project]/components/Room.tsx",
                                    lineNumber: 99,
                                    columnNumber: 17
                                }, this),
                                /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("button", {
                                    onClick: handleJoin,
                                    style: styles.joinButton,
                                    children: "この部屋に入る"
                                }, void 0, false, {
                                    fileName: "[project]/components/Room.tsx",
                                    lineNumber: 106,
                                    columnNumber: 17
                                }, this)
                            ]
                        }, void 0, true)
                    ]
                }, void 0, true) : /*#__PURE__*/ (0, __TURBOPACK__imported__module__$5b$externals$5d2f$react$2f$jsx$2d$dev$2d$runtime__$5b$external$5d$__$28$react$2f$jsx$2d$dev$2d$runtime$2c$__cjs$29$__["jsxDEV"])("p", {
                    children: "部屋を選択してください"
                }, void 0, false, {
                    fileName: "[project]/components/Room.tsx",
                    lineNumber: 113,
                    columnNumber: 11
                }, this)
            }, void 0, false, {
                fileName: "[project]/components/Room.tsx",
                lineNumber: 83,
                columnNumber: 7
            }, this)
        ]
    }, void 0, true, {
        fileName: "[project]/components/Room.tsx",
        lineNumber: 63,
        columnNumber: 5
    }, this);
}
// 🎮 ゲーム風デザインのスタイル定義
const styles = {
    container: {
        display: 'flex',
        padding: '2rem',
        fontFamily: '"Press Start 2P", monospace',
        gap: '2rem',
        backgroundColor: '#121212',
        color: '#00ffcc',
        minHeight: '100vh'
    },
    roomList: {
        width: '40%',
        paddingRight: '1rem'
    },
    roomItem: {
        padding: '1rem',
        backgroundColor: '#1e1e1e',
        border: '2px solid #00ffcc',
        borderRadius: '8px',
        marginBottom: '0.75rem',
        cursor: 'pointer',
        boxShadow: '0 0 10px #00ffcc88',
        transition: 'transform 0.2s, box-shadow 0.2s',
        display: 'flex',
        justifyContent: 'space-between'
    },
    roomDetail: {
        width: '60%',
        backgroundColor: '#1a1a1a',
        padding: '1.5rem',
        borderRadius: '8px',
        boxShadow: '0 0 15px #00ffcc88',
        border: '2px solid #00ffcc'
    },
    joinButton: {
        marginTop: '1rem',
        padding: '0.75rem 1.5rem',
        backgroundColor: '#00ffcc',
        color: '#121212',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: 'bold',
        fontSize: '1rem',
        boxShadow: '0 0 10px #00ffcc',
        transition: 'background-color 0.2s, box-shadow 0.2s'
    },
    input: {
        padding: '0.5rem',
        width: '100%',
        marginTop: '1rem',
        marginBottom: '0.5rem',
        fontSize: '1rem',
        backgroundColor: '#2a2a2a',
        color: '#00ffcc',
        border: '1px solid #00ffcc',
        borderRadius: '4px'
    }
};
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, false);}),
"[project]/components/Room.tsx [ssr] (ecmascript, next/dynamic entry)", ((__turbopack_context__) => {

__turbopack_context__.n(__turbopack_context__.i("[project]/components/Room.tsx [ssr] (ecmascript)"));
}),
"[externals]/socket.io-client [external] (socket.io-client, esm_import, [project]/node_modules/socket.io-client)", ((__turbopack_context__) => {
"use strict";

return __turbopack_context__.a(async (__turbopack_handle_async_dependencies__, __turbopack_async_result__) => { try {

const mod = await __turbopack_context__.y("socket.io-client-1474daefd4249f15");

__turbopack_context__.n(mod);
__turbopack_async_result__();
} catch(e) { __turbopack_async_result__(e); } }, true);}),
];

//# sourceMappingURL=%5Broot-of-the-server%5D__21ce5cdf._.js.map