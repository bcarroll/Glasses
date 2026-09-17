(function() {
	'use strict';
	
	let CHEMION_TYPE = {
		REQUEST: 0x01,
		REPLY: 0x02,
		STREAM: 0x03,
		NOTIFY: 0x04,
		ERROR: 0x05,
		IDENTIFY: 0x06,
	}

	function toHex(bytes) {
		return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
	}
	
	let CHEMION_COMMAND = {
		BATTERY_LEVEL: 0x03,
		FIRMWARE_VERSION: 0x08,
		FRAME_DATA: 0x06,
		// Slot commands below are confirmed message-type IDs from public CHEMION
		// protocol reverse-engineering (https://github.com/gsuberland/ChemionHacking/wiki),
		// but the exact payload layout is NOT publicly documented. The layout used here
		// is a best-effort guess modeled on FRAME_DATA's own (known-working) encoding.
		// It has not been validated against real hardware yet.
		FRAMES_TRANSMISSION_START: 0x0a,
		FRAMES_TRANSMISSION_END: 0x0b,
		FRAMES_TRANSMISSION: 0x0c,
		FRAMES_RECEIVING_FROM_SLOT_START: 0x0d,
		PLAY_FRAMES_ON_SLOT: 0x0e,
		DELETE_SLOT_DATA: 0x0f,
	}

	const SLOT_COUNT = 5;

	class BluetoothChemion {
		constructor() {
			this._EVENTS = {};
			this._PROMISES = {};
			
            this._TX = null;
            this._RX = null;

			this._QUEUE = [];
			this._WORKING = false;
			this._IDLE_WAITERS = [];

			this._RX_BUFFER = new Uint8Array(0);
		}
		
		connect() {
            return new Promise(async (resolve, reject) => {
				try {
		            let device = await navigator.bluetooth.requestDevice({
				        filters: [
				        	{ namePrefix: 'CHEMION' }
				        ],
				        optionalServices: [
					        '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
					    ]
					});
					
					device.addEventListener('gattserverdisconnected', this._disconnect.bind(this));
					
					let server = await device.gatt.connect();				
					let service = await server.getPrimaryService('6e400001-b5a3-f393-e0a9-e50e24dcca9e');

					this._TX = await service.getCharacteristic('6e400002-b5a3-f393-e0a9-e50e24dcca9e');

					this._RX = await service.getCharacteristic('6e400003-b5a3-f393-e0a9-e50e24dcca9e');
					this._RX.startNotifications();
					this._RX_BUFFER = new Uint8Array(0);
					this._RX.addEventListener('characteristicvaluechanged', function(e) {
						let value = e.target.value;
						this._onNotify(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
					}.bind(this));


		            resolve();
		        }
				catch(error) {
	                console.log('Could not connect! ' + error);
					reject();
				}
			});
        }
        
        getBattery() {
            return new Promise((resolve) => {
	            this._PROMISES.battery = resolve;
	            
				let payload = new Uint8Array(3);
				payload[0] = 0x01;
				payload[1] = 0x00;
				payload[2] = CHEMION_COMMAND.BATTERY_LEVEL;
				this._queue(this._encodeMessage(CHEMION_TYPE.REQUEST, payload));
			});
        }
        
        getFirmware() {
            return new Promise((resolve) => {
	            this._PROMISES.firmware = resolve;
	            
				let payload = new Uint8Array(3);
				payload[0] = 0x01;
				payload[1] = 0x00;
				payload[2] = CHEMION_COMMAND.FIRMWARE_VERSION;
				this._queue(this._encodeMessage(CHEMION_TYPE.REQUEST, payload));
			});
        }
        
		frame(data) {
			let payload = new Uint8Array(57);
			payload[0] = 0x01;
			payload[1] = 0x00;
			payload[2] = CHEMION_COMMAND.FRAME_DATA;

			payload.set(this._packPixels(data), 3);

			this._queue(this._encodeMessage(CHEMION_TYPE.STREAM, payload));
   		}

		// Saves an array of { data, duration } frames to one of the glasses' on-device
		// slots (1-5), so it can be played back later without a phone/browser connected.
		//
		// NOTE: the CHEMION Bluetooth protocol's slot-save payload format is not
		// publicly documented (only the message-type IDs are confirmed - see the
		// comment above CHEMION_COMMAND). This is a best-effort implementation modeled
		// on the known-working FRAME_DATA encoding. It has not been validated against
		// real hardware. If it doesn't work, check the console: unrecognized replies
		// from the glasses are logged so the payload layout can be corrected.
		saveToSlot(slot, frames) {
			return new Promise((resolve, reject) => {
				if (!this.isConnected()) {
					reject(new Error('Not connected to glasses'));
					return;
				}

				if (slot < 1 || slot > SLOT_COUNT) {
					reject(new Error('Slot must be between 1 and ' + SLOT_COUNT));
					return;
				}

				if (!frames || !frames.length) {
					reject(new Error('No frames to save'));
					return;
				}

				let startPayload = new Uint8Array(6);
				startPayload[0] = 0x01;
				startPayload[1] = 0x00;
				startPayload[2] = CHEMION_COMMAND.FRAMES_TRANSMISSION_START;
				startPayload[3] = slot;
				startPayload[4] = (frames.length >> 8) & 0xff;
				startPayload[5] = frames.length & 0xff;
				this._queue(this._encodeMessage(CHEMION_TYPE.REQUEST, startPayload));

				frames.forEach((frameData, index) => {
					let payload = new Uint8Array(60);
					payload[0] = 0x01;
					payload[1] = 0x00;
					payload[2] = CHEMION_COMMAND.FRAMES_TRANSMISSION;
					payload[3] = index;
					payload[4] = (frameData.duration >> 8) & 0xff;
					payload[5] = frameData.duration & 0xff;

					payload.set(this._packPixels(frameData.data), 6);

					this._queue(this._encodeMessage(CHEMION_TYPE.STREAM, payload));
				});

				let endPayload = new Uint8Array(4);
				endPayload[0] = 0x01;
				endPayload[1] = 0x00;
				endPayload[2] = CHEMION_COMMAND.FRAMES_TRANSMISSION_END;
				endPayload[3] = slot;
				this._queue(this._encodeMessage(CHEMION_TYPE.REQUEST, endPayload));

				let pending = {
					resolve: () => { this._PROMISES.saveSlot = null; resolve(); },
					reject: (error) => { this._PROMISES.saveSlot = null; reject(error); },
				};
				this._PROMISES.saveSlot = pending;

				// Wait for all bytes to be physically written, then give the glasses a
				// moment to reply with an ERROR before declaring success - writeValue()
				// resolving only means the bytes were sent, not that they were accepted.
				this._whenIdle().then(() => {
					setTimeout(() => {
						if (this._PROMISES.saveSlot === pending) {
							pending.resolve();
						}
					}, 500);
				});
			});
		}

		// Loads the frames saved in an on-device slot (1-5) back into the app.
		//
		// CONFIRMED NOT WORKING as of real hardware testing: the glasses reject
		// FRAMES_RECEIVING_FROM_SLOT_START with an ERROR (code 1) even for slots that
		// hold real animations saved via the official CHEMION app - so this isn't just
		// an "empty slot" response, the request itself is wrong in some way that
		// couldn't be pinned down without a genuine packet capture of the official app
		// performing a load. Left in place (UI-labeled experimental) for future
		// debugging rather than removed; saveToSlot() is the supported path.
		loadFromSlot(slot) {
			return new Promise((resolve, reject) => {
				if (!this.isConnected()) {
					reject(new Error('Not connected to glasses'));
					return;
				}

				if (slot < 1 || slot > SLOT_COUNT) {
					reject(new Error('Slot must be between 1 and ' + SLOT_COUNT));
					return;
				}

				let timeout = setTimeout(() => {
					if (this._PROMISES.loadSlot) {
						this._PROMISES.loadSlot = null;
						reject(new Error('Timed out waiting for slot data from glasses'));
					}
				}, 8000);

				this._PROMISES.loadSlot = {
					frames: [],
					resolve: (frames) => { clearTimeout(timeout); resolve(frames); },
					reject: (error) => { clearTimeout(timeout); reject(error); },
				};

				let payload = new Uint8Array(4);
				payload[0] = 0x01;
				payload[1] = 0x00;
				payload[2] = CHEMION_COMMAND.FRAMES_RECEIVING_FROM_SLOT_START;
				payload[3] = slot;
				this._queue(this._encodeMessage(CHEMION_TYPE.REQUEST, payload));
			});
		}

		_packPixels(data) {
			let packed = new Uint8Array(54);

			for (let i = 0; i < 54; i++) {
				packed[i] =
					(data[(i * 4)    ] >> 6 << 6) |
					(data[(i * 4) + 1] >> 6 << 4) |
					(data[(i * 4) + 2] >> 6 << 2) |
					(data[(i * 4) + 3] >> 6);
			}

			return packed;
		}

		_unpackLevels(packed) {
			let levels = new Uint8Array(216);

			for (let i = 0; i < 54; i++) {
				let byte = packed[i] || 0;
				levels[(i * 4)]     = (byte >> 6) & 0x03;
				levels[(i * 4) + 1] = (byte >> 4) & 0x03;
				levels[(i * 4) + 2] = (byte >> 2) & 0x03;
				levels[(i * 4) + 3] = byte & 0x03;
			}

			return levels;
		}

		// BLE notifications are capped at ~20 bytes, same as our outgoing writes, so any
		// reply longer than that (e.g. a saved frame coming back from loadFromSlot) arrives
		// split across multiple notification events. This buffers incoming bytes and pulls
		// out complete, checksum-valid messages as they become available, resyncing on the
		// 0xfa start marker if anything unexpected shows up in between.
		_onNotify(chunk) {
			let combined = new Uint8Array(this._RX_BUFFER.length + chunk.length);
			combined.set(this._RX_BUFFER, 0);
			combined.set(chunk, this._RX_BUFFER.length);
			this._RX_BUFFER = combined;

			while (true) {
				let start = this._RX_BUFFER.indexOf(0xfa);

				if (start === -1) {
					this._RX_BUFFER = new Uint8Array(0);
					return;
				}

				if (start > 0) {
					console.log('BluetoothChemion: discarding ' + start + ' byte(s) before next 0xfa marker: ' + toHex(this._RX_BUFFER.slice(0, start)));
					this._RX_BUFFER = this._RX_BUFFER.slice(start);
				}

				if (this._RX_BUFFER.length < 4) return;

				let payloadLength = (this._RX_BUFFER[2] << 8) | this._RX_BUFFER[3];
				let totalLength = payloadLength + 7;

				if (this._RX_BUFFER.length < totalLength) return;

				let messageBytes = this._RX_BUFFER.slice(0, totalLength);
				this._RX_BUFFER = this._RX_BUFFER.slice(totalLength);

				try {
					let view = new DataView(messageBytes.buffer, messageBytes.byteOffset, messageBytes.byteLength);
					let reply = this._decodeMessage(view);

					if (reply.type === CHEMION_TYPE.REPLY || reply.type === CHEMION_TYPE.STREAM) {
						this._handleReply(reply.payload);
					} else if (reply.type === CHEMION_TYPE.ERROR) {
						this._handleError(reply.payload);
					} else {
						console.log('BluetoothChemion: notification with unhandled message type 0x' + reply.type.toString(16) + ' - payload: ' + toHex(reply.payload));
					}
				}
				catch (error) {
					console.log('Could not decode message! ' + error + ' - raw bytes: ' + toHex(messageBytes));
				}
			}
		}

		addEventListener(e, f) {
			this._EVENTS[e] = f;
		}

		isConnected() {
			return !!(this._TX && this._RX);
		}
			
		_disconnect() {
            console.log('Disconnected from GATT Server...');

			this._TX = null;
			this._RX = null;
			
			if (this._EVENTS['disconnected']) {
				this._EVENTS['disconnected']();
			}
		}
		
		_queue(message) {
			var that = this;

			function run() {
				if (!that._QUEUE.length) {
					that._WORKING = false;

					let waiters = that._IDLE_WAITERS;
					that._IDLE_WAITERS = [];
					waiters.forEach((resolve) => resolve());

					return;
				}

				that._WORKING = true;
                that._TX.writeValue(that._QUEUE.shift()).then(() => run() );
			}

            const maxLength = 20;
            let chunks = Math.ceil(message.length / maxLength);

            if (chunks === 1) {
                that._QUEUE.push(message);
            } else {
                for (let i = 0; i < chunks; i++) {
                    let byteOffset = i * maxLength;
                    let length = Math.min(message.length, byteOffset + maxLength);
                    that._QUEUE.push(message.slice(byteOffset, length));
                }
            }
			
			if (!that._WORKING) run();
		}

		_whenIdle() {
			return new Promise((resolve) => {
				if (!this._WORKING && !this._QUEUE.length) {
					resolve();
					return;
				}

				this._IDLE_WAITERS.push(resolve);
			});
		}


		_encodeMessage(type, payload) {
			let message = new Uint8Array(payload.length + 7);
			
			message[0] = 0xfa;
			message[1] = type;
			message[2] = payload.length / 0xff;
			message[3] = payload.length % 0xff;
			
			message.set(payload, 4);
			
			message[message.length - 3] = payload.reduce((p, c) => p ^ c);
			message[message.length - 2] = 0x55;
			message[message.length - 1] = 0xa9;
			
			return message;
		}
		
		_decodeMessage(message) {
			if (message.getUint8(0) != 0xfa) {
				throw new Error('Message does not start with 0xfa');
			}
			
			if (message.getUint16(message.byteLength - 2) != 0x55a9) {
				throw new Error('Message does not end with 0x55a9');
			}
			
			if (message.getUint16(2) != message.byteLength - 7) {
				throw new Error('Message does not have the correct size');
			}
			
			let type = message.getUint8(1);
			let payload = new Uint8Array(message.buffer.slice(4, -3));

			if (message.getUint8(message.byteLength - 3) != payload.reduce((p, c) => p ^ c)) {
				throw new Error('Checksum is not correct');
			}
		
			return { type, payload };
		}
		
		_handleReply(payload) {
			let command = payload[2];
			
			switch (command) {
				case CHEMION_COMMAND.BATTERY_LEVEL:
					if (this._PROMISES.battery) {
						this._PROMISES.battery(payload[3]);
					}
					
					break;
					
				case CHEMION_COMMAND.FIRMWARE_VERSION:
					if (this._PROMISES.firmware) {
						this._PROMISES.firmware(payload[3] + '.' + payload[4] + '.' + payload[5]);
					}

					break;

				case CHEMION_COMMAND.FRAMES_TRANSMISSION:
					if (this._PROMISES.loadSlot) {
						let frameIndex = payload[3];
						let duration = (payload[4] << 8) | payload[5];
						let levels = this._unpackLevels(payload.slice(6, 60));

						this._PROMISES.loadSlot.frames[frameIndex] = { levels, duration };
					}

					break;

				case CHEMION_COMMAND.FRAMES_TRANSMISSION_END:
					if (this._PROMISES.loadSlot) {
						let result = this._PROMISES.loadSlot;
						this._PROMISES.loadSlot = null;

						if (!result.frames.length || result.frames.includes(undefined)) {
							result.reject(new Error('Incomplete frame data received from glasses'));
						} else {
							result.resolve(result.frames);
						}
					}

					break;

				default:
					console.log('BluetoothChemion: unhandled reply command 0x' + command.toString(16) + ' - payload: ' + toHex(payload));
			}
		}

		// Observed ERROR payload shape (from real hardware testing): [0, erroredCommand, errorCode].
		// Note this is NOT the same layout as REPLY payloads (which carry the command at
		// index 2, prefixed by a 2-byte sequence) - errors appear to drop that prefix.
		_handleError(payload) {
			let erroredCommand = payload[1];
			let errorCode = payload[2];

			console.log(
				'BluetoothChemion: glasses returned ERROR for command 0x' + erroredCommand.toString(16) +
				' (code ' + errorCode + ') - full payload: ' + toHex(payload)
			);

			if (
				erroredCommand === CHEMION_COMMAND.FRAMES_RECEIVING_FROM_SLOT_START &&
				this._PROMISES.loadSlot
			) {
				let result = this._PROMISES.loadSlot;
				this._PROMISES.loadSlot = null;
				result.reject(new Error('Glasses rejected slot load (command 0x' + erroredCommand.toString(16) + ', code ' + errorCode + ')'));
				return;
			}

			if (
				(erroredCommand === CHEMION_COMMAND.FRAMES_TRANSMISSION_START ||
					erroredCommand === CHEMION_COMMAND.FRAMES_TRANSMISSION ||
					erroredCommand === CHEMION_COMMAND.FRAMES_TRANSMISSION_END) &&
				this._PROMISES.saveSlot
			) {
				let result = this._PROMISES.saveSlot;
				this._PROMISES.saveSlot = null;
				result.reject(new Error('Glasses rejected slot save (command 0x' + erroredCommand.toString(16) + ', code ' + errorCode + ')'));
			}
		}
	}

	window.BluetoothChemion = new BluetoothChemion();
})();

