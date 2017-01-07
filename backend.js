"use strict";

var Widget = require(__dirname + "/../../../src/widget");
var steamapi = require(__dirname + "/../../../src/steamapi");

var widget = new Widget();

/** @type {object} */
widget.serverstatus = {};

/**
 * On rcon server has successfully connected and authenticated
 * @param {RconServer} server
 */
widget.onServerConnected = function (server) {
    widget.updateServerstatus(server);
};

/**
 * Fired when widget is added to a server dashboard
 * @param {RconServer} server
 */
widget.onWidgetAdded = function (server) {
    widget.updateServerstatus(server);
};

/**
 * On frontend message
 * @param {RconServer} server
 * @param {WebSocketUser} user
 * @param {string} action The action
 * @param {*} messageData Any message data received from frontend
 * @param {function} callback Pass an object as message data response for the frontend
 */
widget.onFrontendMessage = function (server, user, action, messageData, callback) {
    switch (action) {
        case "serverstatus":
            if (messageData.forceUpdate) {
                widget.updateServerstatus(server, function () {
                    callback(widget, widget.serverstatus[server.id]);
                });
            } else {
                callback(widget, widget.serverstatus[server.id]);
            }
            break;
    }
};

/**
 * Update the serverstatus
 * @param {RconServer} server
 * @param {function=} callback
 */
widget.updateServerstatus = function (server, callback) {
    server.cmd("status", null, false, function (statusData) {
        if (!statusData) statusData = "";
        var statusDataLines = statusData.split("\n");
        if (!statusDataLines || statusDataLines.length < 3) {
            if (callback) callback();
            return;
        }
        var hostname = statusDataLines[0].split(":").slice(1);
        var version = statusDataLines[1].split(":").slice(1);
        var map = statusDataLines[2].split(":").slice(1);
        var players = statusDataLines[3].split(":").slice(1);

        var newStatus = {
            "server": {
                "hostname": hostname ? hostname.join(":").trim() : "",
                "players": players ? players.join(":").trim() : "",
                "version": version ? version.join(":").trim() : "",
                "map": map ? map.join(":").trim() : ""
            },
            "players": {
                "onlineCount": 0,
                "bannedCount": 0,
                "online": {},
                "banned": {}
            }
        };
        server.cmd("playerlist", null, false, function (playerlistData) {
            var playerlist = [];
            try {
                playerlist = JSON.parse(playerlistData);
            } catch (e) {
            }
            var playerlistObject = {};
            var ids = [];
            for (var i = 0; i < playerlist.length; i++) {
                var player = playerlist[i];
                var playerLower = {};
                for (var playerIndex in player) {
                    if (player.hasOwnProperty(playerIndex)) {
                        playerLower[playerIndex.toLowerCase()] = player[playerIndex];
                    }
                }
                playerLower.vacstatus = {};
                playerlistObject[playerLower.steamid] = playerLower;
                ids.push(playerLower.steamid);
            }
            newStatus.players.onlineCount = playerlist.length;
            newStatus.players.online = playerlistObject;
            steamapi.request("bans", ids, function (banStatus) {
                for (var banIndex in banStatus) {
                    if (banStatus.hasOwnProperty(banIndex)) {
                        var banRow = banStatus[banIndex];
                        var status = "ok";
                        var newBanRow = {};
                        for (var steamIndex in banRow) {
                            if (banRow.hasOwnProperty(steamIndex)) {
                                var steamValue = banRow[steamIndex];
                                steamIndex = steamIndex.toLowerCase();
                                if (steamIndex == "economyban") steamValue = steamValue != "none";
                                if (steamIndex != "timestamp" && steamIndex != "steamid" && steamValue) {
                                    status = "suspicious";
                                }
                                newBanRow[steamIndex] = steamValue;
                            }
                        }
                        newBanRow.status = status;
                        newStatus.players.online[newBanRow.steamid].vacstatus = newBanRow;
                    }
                }

                // get bans from server
                server.cmd("bans", null, false, function (messageData) {
                    if (messageData) {
                        // fix for 64bit integer
                        messageData = messageData.replace(/(\"steamid\"\s*:\s*)([0-9]+)/g, function (all) {
                            return all.replace(/[0-9]+/, "\"$&\"")
                        });
                        try {
                            var bans = JSON.parse(messageData);
                            newStatus.players.bannedCount = bans.length;
                            for (var i = 0; i < bans.length; i++) {
                                newStatus.players.banned[bans[i].steamid] = bans[i];
                            }
                        } catch (e) {

                        }
                    }
                    newStatus.timestamp = new Date();
                    widget.serverstatus[server.id] = newStatus;
                    if (callback) callback();
                    widget.sendMessageToFrontend(server, {"serverstatus" : true});
                });
            });
        });
    });
};

/**
 * On widget update cycle - Fired every 30 seconds for each server
 * @param {RconServer} server
 */
widget.onUpdate = function (server) {
    // only update serverstatus each 2 minutes
    if (!widget.serverstatus[server.id] || widget.serverstatus[server.id].timestamp.getTime() / 1000 < new Date().getTime() / 1000 - 120) {
        widget.updateServerstatus(server);
    }
};

module.exports = widget;