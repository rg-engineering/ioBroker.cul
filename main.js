/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';
var Main = process.env.DEBUG ? require('./lib/debugCul.js') : require('main');

// you have to require the utils module and call adapter function
var utils = require('@iobroker/adapter-core'); // Get common adapter utils

var cul;
var objects   = {};
var metaRoles = {};
var SerialPort;
var Net;

var adapter = utils.Adapter('cul');

try {
    SerialPort = require('serialport');//.SerialPort;
} catch (e) {
    console.warn('Serial port is not available');
}
try {
    Net = require('net');
} catch (e) {
    console.warn('Net is not available');
}

adapter.on('stateChange', function (id, state) {
    if (!state.ack) {
        adapter.log.debug('State Change ' + JSON.stringify(id) + ', State: ' + JSON.stringify(state));
        //  State Change "cul.0.FS20.123401.cmd" State: {"val":2,"ack":false,"ts":1581365531968,"q":0,"from":"system.adapter.admin.0","user":"system.user.admin","lc":1581365531968}
        var oAddr = id.split('.');
        // 0: cul; 1:0; 2:FS20; 3:123401; 4:cmd;
        var sHousecode = oAddr[3].substring(0, 4);
        var sAddress   = oAddr[3].substring(4, 6);
        if (oAddr[2] === 'FS20' || adapter.config.experimental === true || adapter.config.experimental === 'true') {
            switch (oAddr[4]) {
                case 'cmdRaw':
                    sendCommand({protocol: oAddr[2], housecode: sHousecode, address: sAddress, command: state.val});
                    break;
                    
                deafult:
                    adapter.log.error('Write of State ' + oAddr[4] + ' currently not implemented');
                    break;
            }
        } else {
            dapter.log.error('Only FS20 Devices are tested. Please contribute here: https://github.com/ioBroker/ioBroker.cul');
        }
    }
});

adapter.on('unload', function (callback) {
    if (cul) {
        try {
            cul.close();
        } catch (e) {
            adapter.log.error('Cannot close serial port: ' + e.toString());
        }
    }
    callback();
});

adapter.on('ready', function () {
    adapter.setState('info.connection', false, true);
    
    checkPort(function (err) {
        if (!err || process.env.DEBUG) {
            main();
        } else {
            adapter.log.error('Cannot open port: ' + err);
        }
    });
});

adapter.on('message', function (obj) {
    if (obj) {
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    if (SerialPort) {
                        // read all found serial ports
                        SerialPort.list(function (err, ports) {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }
                break;
                
            case 'send':
                sendCommand({protocol: obj.message.protocol, housecode: obj.message.housecode, address: obj.message.address, command: obj.message.command});
                break;
                
            default:
                adapter.log.error('No such command: ' + obj.command);
                break;
        }
    }
});

/***
 * Send a command to the cul module
 * @param {obj.message.protocol, obj.message.housecode, obj.message.address, obj.message.command} 
 */
function sendCommand(o) {
    adapter.log.info('Send command received. Housecode: ' + o.housecode + '; address: ' + o.address + '; command: ' + o.command);
    cul.cmd(o.protocol, o.housecode, o.address, o.command);
}

function checkConnection(host, port, timeout, callback) {
        timeout = timeout || 10000; //default 10 seconds
    
        var timer = setTimeout(function() {
            socket.end();
            callback('Timeout');
            callback = null;
        }, timeout);
    
        var socket = Net.createConnection(port, host, function() {
            clearTimeout(timer);
            socket.end();
            callback(null);
            callback = null;
        });
    
        socket.on('error', function(err) {
            clearTimeout(timer);
            socket.end();
            callback(err);
            callback = null;
        });
}

function checkPort(callback) {
    if (adapter.config.type === 'cuno') {
        checkConnection(adapter.config.ip, adapter.config.port, 10000, function(err) {
            callback && callback(err);
            callback = null;
        });
    } else {
        if (!adapter.config.serialport) {
            callback && callback('Port is not selected');
            return;
        }
        var sPort;
        try {
            sPort = new SerialPort(adapter.config.serialport || '/dev/ttyACM0', {
                baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
                autoOpen: false
            });
            sPort.on('error', function (err) {
                if (sPort.isOpen) sPort.close();
                callback && callback(err);
                callback = null;
            });

            sPort.open(function (err) {
                sPort.isOpen && sPort.close();
                callback && callback(err);
                callback = null;
            });
        } catch (e) {
            adapter.log.error('Cannot open port: ' + e);
            try {
                sPort.isOpen && sPort.close();
            } catch (ee) {

            }
            callback && callback(e);
        }
    }
}

var tasks = [];

function processTasks() {
    if (tasks.length) {
        var task = tasks.shift();
        
        if (task.type === 'state') {
            adapter.setForeignState(task.id, task.val, true, function () {
                setTimeout(processTasks, 0);
            });
        } else if (task.type === 'object') {
            adapter.getForeignObject(task.id, function (err, obj) {
                if (!obj) {
                    adapter.setForeignObject(task.id, task.obj, function (err, res) {
                        adapter.log.info('object ' + adapter.namespace + '.' + task.id + ' created');
                        setTimeout(processTasks, 0);
                    });
                } else {
                    var changed = false;
                    if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                        obj.native = task.obj.native;
                        changed = true;
                    }

                    if (changed) {
                        adapter.setForeignObject(obj._id, obj, function (err, res) {
                            adapter.log.info('object ' + adapter.namespace + '.' + obj._id + ' created');
                            setTimeout(processTasks, 0);
                        });
                    } else {
                        setTimeout(processTasks, 0);
                    }
                }
            });
        }
    }
}

function setStates(obj) {
    var id = obj.protocol + '.' + obj.address;
    var isStart = !tasks.length;

    for (var state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) {
            continue;
        }
        var oid  = adapter.namespace + '.' + id + '.' + state;
        var meta = objects[oid];
        var val  = obj.data[state];
        if (meta) {
            if (meta.common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (meta.common.type === 'number') {
                if (val === 'on'  || val === 'true'  || val === true)  val = 1;
                if (val === 'off' || val === 'false' || val === false) val = 0;
                val = parseFloat(val);
            }
        }
        tasks.push({type: 'state', id: oid, val: val});
    }
    isStart && processTasks();
}

function connect() {
    var options = {
        connectionMode: adapter.config.type === 'cuno' ? 'telnet' : 'serial' ,
        serialport: adapter.config.serialport || '/dev/ttyACM0',
        mode:       adapter.config.mode       || 'SlowRF',
        baudrate:   parseInt(adapter.config.baudrate, 10) || 9600,
        scc:        adapter.config.type === 'scc',
        coc:        adapter.config.type === 'coc',
        host:       adapter.config.ip,
        port:       adapter.config.port,
        debug:      true,
        logger:     adapter.log.debug
    };

    cul = new Main(options);

    cul.on('close', function () {
        adapter.setState('info.connection', false, true);
        //cul.close();
        setTimeout(function () {
            cul = null;
            connect();
        }, 10000);
    });

    cul.on('ready', function () {
        adapter.setState('info.connection', true, true);
    });

    cul.on('data', function (raw, obj) {
        adapter.log.debug('RAW: ' + raw + ', ' + JSON.stringify(obj));
        adapter.setState('info.rawData', raw, true);

        if (!obj || !obj.protocol || !obj.address) return;
        var id = obj.protocol + '.' + obj.address;

        var isStart = !tasks.length;
        if (!objects[adapter.namespace + '.' + id]) {

            var newObjects = [];
            var tmp = JSON.parse(JSON.stringify(obj));
            delete tmp.data;

            var newDevice = {
                _id:    adapter.namespace + '.' + id,
                type:   'device',
                common: {
                    name: (obj.device ? obj.device + ' ' : '') + obj.address
                },
                native: tmp
            };
            for (var _state in obj.data) {
                if (!obj.data.hasOwnProperty(_state)) continue;
                var common;

                if (obj.device && metaRoles[obj.device + '_' + _state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[obj.device + '_' + _state]));
                } else if (metaRoles[_state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[_state]));
                } else {
                    common = JSON.parse(JSON.stringify(metaRoles['undefined']));
                }

                common.name = _state + ' ' + (obj.device ? obj.device + ' ' : '') + id;

                var newState = {
                    _id:    adapter.namespace + '.' + id + '.' + _state,
                    type:   'state',
                    common: common,
                    native: {}
                };

                objects[adapter.namespace + '.' + id + '.' + _state] = newState;
                tasks.push({type: 'object', id: newState._id, obj: newState});
            }
            objects[adapter.namespace + '.' + id] = newDevice;
            tasks.push({type: 'object', id: newDevice._id, obj: newDevice});
        }

        setStates(obj);
        isStart && processTasks();
    });

}

function main() {
    
    // in this template all states changes inside the adapters namespace are subscribed
    adapter.subscribeStates('*');
    
    adapter.getForeignObject('cul.meta.roles', function (err, res) {
        metaRoles = res.native;
        adapter.getObjectView('system', 'device', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, function (err, res) {
            for (var i = 0, l = res.rows.length; i < l; i++) {
                objects[res.rows[i].id] = res.rows[i].value;
            }
            adapter.getObjectView('system', 'state', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, function (err, res) {
                for (var i = 0, l = res.rows.length; i < l; i++) {
                    objects[res.rows[i].id] = res.rows[i].value;
                }
                connect();
            });
        });
    });
}
