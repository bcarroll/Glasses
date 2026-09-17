(function() {
	'use strict';
	
	let CHEMION_TYPE = {
		REQUEST: 0x01,
		REPLY: 0x02,
		STREAM: 0x03
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
					this._RX.addEventListener('characteristicvaluechanged', function(e) { 
						try {
							let reply = this._decodeMessage(e.target.value);
						
							if (reply.type === CHEMION_TYPE.REPLY) {
								this._handleReply(reply.payload);
							}
						}
						catch(error) {
							console.log('Could not decode message! ' + error, e.target.value);
						}
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

				this._whenIdle().then(resolve);
			});
		}

		// Loads the frames saved in an on-device slot (1-5) back into the app.
		// Same best-effort caveat as saveToSlot() above applies - the reply payload
		// layout is assumed to mirror what we send, not confirmed against hardware.
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
					console.log('BluetoothChemion: unhandled reply command 0x' + command.toString(16) + ' - payload:', payload);
			}
		}
	}

	window.BluetoothChemion = new BluetoothChemion();
})();

