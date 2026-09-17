let data = new Uint8Array(216);

const LED_LEVELS = [0x00, 0x59, 0xa6, 0xff]; // 0%, 35%, 65%, 100%

function createFrame(duration = 150) {
	return {
		levels: new Uint8Array(216),
		data: new Uint8Array(216),
		duration: duration,
	};
}

let frames = [createFrame()];
let currentFrame = 0;




/* Pills */

document.getElementById('text').addEventListener('click', (e) => {
	document.body.classList.remove('text', 'equalizer', 'design');
	document.body.classList.add('text');
	stopDesignAnimation();
});

document.getElementById('equalizer').addEventListener('click', (e) => {
	document.body.classList.remove('text', 'equalizer', 'design');
	document.body.classList.add('equalizer');
	stopDesignAnimation();
});

document.getElementById('design').addEventListener('click', (e) => {
	document.body.classList.remove('text', 'equalizer', 'design');
	document.body.classList.add('design');
	renderDesignPreview();
});




/* Connect to device */
emulateState = false;

document.getElementById('connect')
	.addEventListener('click', () => {
		BluetoothChemion.connect()
			.then(() => {
				document.body.classList.add('connected');
				
				BluetoothChemion.addEventListener('disconnected', () => {
					document.body.classList.remove('connected');
				});
				
				startText();
				startAnalyzer();
			})
			.catch((error) => {
				console.log(error);
			});
	});

document.getElementById('emulate')
	.addEventListener('click', () => {
	    emulateState = true;
		document.body.classList.add('connected');

		function emulate() {
			startText();
			startAnalyzer();
		}

		emulate();
	});




/* Draw text */

function startText() {
	let pos = 0;
	let width = 24;
	
	
	function renderText() {
		let source = document.getElementById('sourceText').value;
		let chars = Char8.transform(source);
		
		width = Math.max(24, (chars.length + 1) * 8);
	 	let canvas = new Uint8Array(width * 8);
	 	
		for (i = 0; i < chars.length; i++) {
			let glyph = Char8.getGlyph(chars[i]);
			
			for (y = 0; y < 8; y++) {
				for (x = 0; x < 8; x++) {
					if (glyph[y] & (0x80 >> x)) {
						canvas[(i * 8 + x) + (y * width)] = 0xff;
					}
				}
			}
	    }
	    
	    data = new Uint8Array(216);
		
	    for (y = 0; y < 8; y++) {
		    for (x = 0; x < width; x++) {
			    let l = ((x + pos) % width) + (y * width);
			    data[(y * 24) + 24 + x] = canvas[l];
		    }
	    }
	    
	    if (!emulateState) {
	    	BluetoothChemion.frame(data);
	    }
	    
	    drawGlasses();
	}
	
	setInterval(() => {
		if (!document.body.classList.contains('text')) {
			return;
		}
	
		pos++;
		if (pos > width) pos = 0;	
	
		renderText();
	}, 150);
}	
	



/* Frequency analyzer */

function startAnalyzer() {
	let raw = new Uint8Array(32);
	
	navigator.mediaDevices.getUserMedia({ audio: true })
		.then(stream => {
		    const audioContext = new AudioContext();
		    const input = audioContext.createMediaStreamSource(stream);
		    const analyser = audioContext.createAnalyser();
		    const scriptProcessor = audioContext.createScriptProcessor();
		    
		    analyser.smoothingTimeConstant = 0.3;
		    analyser.fftSize = 256;
		    
		    input.connect(analyser);
		    analyser.connect(scriptProcessor);
		    scriptProcessor.connect(audioContext.destination);
		    
		    scriptProcessor.onaudioprocess = audioProcessingEvent => {
			    analyser.getByteFrequencyData(raw);
			};
		});
	
	
	setInterval(() => {
		if (!document.body.classList.contains('equalizer')) {
			return;
		}
		
	    data = new Uint8Array(216);
	    
	    for (let x = 0; x < 24; x++) {
		    let value = Math.min(0x0a - Math.ceil(raw[x] / 0xff * 0x0a), 0x09);
			for (let y = value; y < 9; y++) {
		    	data[y * 24 + x] = 0xff;					
		    }		    
	    }
	    
	    if (!emulateState) {
	    	BluetoothChemion.frame(data);
	    }
	    
	    drawGlasses();
	}, 150);

	analizerStarted = true;
}




/* Custom design */

function isSpacer(x, y) {
	if (y == 7 && x >= 11 && x <= 12) return true;
	if (y == 8 && x >= 10 && x <= 13) return true;
	return false;
}

function buildDesignGrid() {
	let grid = document.getElementById('designGrid');

	for (let i = 0; i < 216; i++) {
		let x = i % 24;
		let y = Math.floor(i / 24);

		let led = document.createElement('div');
		led.className = 'led';

		if (isSpacer(x, y)) {
			led.classList.add('spacer');
		} else {
			led.dataset.level = 0;

			led.addEventListener('click', () => {
				let frame = frames[currentFrame];

				frame.levels[i] = (frame.levels[i] + 1) % LED_LEVELS.length;
				frame.data[i] = LED_LEVELS[frame.levels[i]];
				led.dataset.level = frame.levels[i];

				renderDesignPreview();
			});
		}

		grid.appendChild(led);
	}
}

buildDesignGrid();

function loadFrameIntoGrid() {
	let leds = document.getElementById('designGrid').children;
	let frame = frames[currentFrame];

	for (let i = 0; i < 216; i++) {
		if (leds[i].classList.contains('spacer')) continue;
		leds[i].dataset.level = frame.levels[i];
	}
}

document.getElementById('clearDesign').addEventListener('click', () => {
	let frame = frames[currentFrame];

	frame.levels.fill(0);
	frame.data.fill(0);
	loadFrameIntoGrid();

	renderDesignPreview();
});

document.getElementById('sendDesign').addEventListener('click', () => {
	if (!emulateState) {
		BluetoothChemion.frame(frames[currentFrame].data);
	}
});

function renderDesignPreview() {
	data = frames[currentFrame].data;
	drawGlasses();
}

function frameFromLevels(levels, duration) {
	let data = new Uint8Array(216);

	for (let i = 0; i < 216; i++) {
		data[i] = LED_LEVELS[levels[i]] || 0;
	}

	return { levels: Uint8Array.from(levels), data, duration };
}

document.getElementById('saveDesign').addEventListener('click', () => {
	let payload = {
		version: 1,
		currentFrame: currentFrame,
		frames: frames.map((frame) => ({
			levels: Array.from(frame.levels),
			duration: frame.duration,
		})),
	};

	let blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
	let url = URL.createObjectURL(blob);

	let link = document.createElement('a');
	link.href = url;
	link.download = 'chemion-design.json';
	link.click();

	URL.revokeObjectURL(url);
});

document.getElementById('loadDesign').addEventListener('click', () => {
	document.getElementById('loadDesignInput').click();
});

document.getElementById('loadDesignInput').addEventListener('change', (e) => {
	let file = e.target.files[0];
	if (!file) return;

	let reader = new FileReader();

	reader.onload = () => {
		try {
			let payload = JSON.parse(reader.result);
			let loadedFrames = payload.frames.map((frame) => frameFromLevels(frame.levels, frame.duration || 150));

			if (!loadedFrames.length) throw new Error('No frames in file');

			stopDesignAnimation();
			frames = loadedFrames;

			selectFrame(Math.min(payload.currentFrame || 0, frames.length - 1));
		} catch (error) {
			console.log(error);
			alert('Could not load design file.');
		}
	};

	reader.readAsText(file);
	e.target.value = '';
});

document.getElementById('saveToGlasses').addEventListener('click', () => {
	if (emulateState || !BluetoothChemion.isConnected()) {
		alert('Connect to your glasses first.');
		return;
	}

	let slot = parseInt(document.getElementById('glassesSlot').value);
	let button = document.getElementById('saveToGlasses');

	button.disabled = true;
	button.textContent = 'Saving...';

	BluetoothChemion.saveToSlot(slot, frames)
		.then(() => {
			button.textContent = 'Saved!';
			setTimeout(() => { button.textContent = 'Save to Glasses'; }, 1500);
		})
		.catch((error) => {
			console.log(error);
			alert(
				'Could not save to glasses slot ' + slot + '. ' +
				'This on-device protocol is best-effort (see console) and may need tuning against your hardware.'
			);
			button.textContent = 'Save to Glasses';
		})
		.finally(() => { button.disabled = false; });
});

document.getElementById('loadFromGlasses').addEventListener('click', () => {
	if (emulateState || !BluetoothChemion.isConnected()) {
		alert('Connect to your glasses first.');
		return;
	}

	let slot = parseInt(document.getElementById('glassesSlot').value);
	let button = document.getElementById('loadFromGlasses');

	button.disabled = true;
	button.textContent = 'Loading...';

	BluetoothChemion.loadFromSlot(slot)
		.then((loadedFrames) => {
			stopDesignAnimation();
			frames = loadedFrames.map((frame) => frameFromLevels(Array.from(frame.levels), frame.duration || 150));
			selectFrame(0);

			button.textContent = 'Loaded!';
			setTimeout(() => { button.textContent = 'Load from Glasses'; }, 1500);
		})
		.catch((error) => {
			console.log(error);
			alert(
				'Could not load glasses slot ' + slot + '. ' +
				'This on-device protocol is best-effort (see console) and may need tuning against your hardware.'
			);
			button.textContent = 'Load from Glasses';
		})
		.finally(() => { button.disabled = false; });
});




/* Design frames */

let dragSourceIndex = null;

function renderFrameStrip() {
	let strip = document.getElementById('frameStrip');
	strip.innerHTML = '';

	frames.forEach((frame, index) => {
		let btn = document.createElement('button');
		btn.className = 'frame-btn' + (index === currentFrame ? ' active' : '');
		btn.textContent = index + 1;
		btn.draggable = true;
		btn.title = 'Click to edit, drag to reorder';

		btn.addEventListener('click', () => selectFrame(index));

		btn.addEventListener('dragstart', (e) => {
			dragSourceIndex = index;
			btn.classList.add('dragging');
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		});

		btn.addEventListener('dragend', () => {
			dragSourceIndex = null;
			document.querySelectorAll('#frameStrip .frame-btn')
				.forEach((el) => el.classList.remove('dragging', 'drag-over'));
		});

		btn.addEventListener('dragover', (e) => {
			if (dragSourceIndex === null || dragSourceIndex === index) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			btn.classList.add('drag-over');
		});

		btn.addEventListener('dragleave', () => {
			btn.classList.remove('drag-over');
		});

		btn.addEventListener('drop', (e) => {
			e.preventDefault();
			btn.classList.remove('drag-over');

			if (dragSourceIndex === null || dragSourceIndex === index) return;
			moveFrame(dragSourceIndex, index);
		});

		strip.appendChild(btn);
	});
}

function moveFrame(fromIndex, toIndex) {
	stopDesignAnimation();

	let activeFrame = frames[currentFrame];
	let [moved] = frames.splice(fromIndex, 1);
	frames.splice(toIndex, 0, moved);

	currentFrame = frames.indexOf(activeFrame);

	renderFrameStrip();
}

function selectFrame(index) {
	stopDesignAnimation();

	currentFrame = index;
	loadFrameIntoGrid();

	document.getElementById('frameDuration').value = frames[currentFrame].duration;

	renderFrameStrip();
	renderDesignPreview();
}

renderFrameStrip();

document.getElementById('addFrame').addEventListener('click', () => {
	let duration = frames[currentFrame].duration;

	frames.splice(currentFrame + 1, 0, createFrame(duration));
	selectFrame(currentFrame + 1);
});

document.getElementById('duplicateFrame').addEventListener('click', () => {
	let source = frames[currentFrame];
	let copy = {
		levels: source.levels.slice(),
		data: source.data.slice(),
		duration: source.duration,
	};

	frames.splice(currentFrame + 1, 0, copy);
	selectFrame(currentFrame + 1);
});

document.getElementById('deleteFrame').addEventListener('click', () => {
	if (frames.length <= 1) return;

	frames.splice(currentFrame, 1);
	selectFrame(Math.min(currentFrame, frames.length - 1));
});

document.getElementById('frameDuration').addEventListener('change', (e) => {
	let value = Math.max(30, parseInt(e.target.value) || 150);

	e.target.value = value;
	frames[currentFrame].duration = value;
});




/* Design animation playback */

let designPlayback = { active: false, timer: null };

function stopDesignAnimation() {
	if (!designPlayback.active) return;

	designPlayback.active = false;
	clearTimeout(designPlayback.timer);

	let playButton = document.getElementById('playDesign');
	playButton.textContent = 'Play';
	playButton.classList.remove('playing');

	renderDesignPreview();
}

function playDesignAnimation() {
	designPlayback.active = true;

	let playButton = document.getElementById('playDesign');
	playButton.textContent = 'Stop';
	playButton.classList.add('playing');

	let loop = document.getElementById('loopDesign').checked;
	let index = 0;

	function step() {
		if (!designPlayback.active) return;

		if (!document.body.classList.contains('design')) {
			stopDesignAnimation();
			return;
		}

		let frame = frames[index];

		data = frame.data;
		drawGlasses();

		if (!emulateState) {
			BluetoothChemion.frame(frame.data);
		}

		let duration = frame.duration;
		index++;

		if (index >= frames.length) {
			if (!loop) {
				stopDesignAnimation();
				return;
			}
			index = 0;
		}

		designPlayback.timer = setTimeout(step, duration);
	}

	step();
}

document.getElementById('playDesign').addEventListener('click', () => {
	if (designPlayback.active) {
		stopDesignAnimation();
	} else {
		playDesignAnimation();
	}
});



/* Draw glasses */

var canvas = document.getElementById('graph');

function drawGlasses() {
	requestAnimationFrame(() => {
		canvas.width = parseInt(getComputedStyle(canvas).width.slice(0, -2)) * devicePixelRatio;
		canvas.height = parseInt(getComputedStyle(canvas).height.slice(0, -2)) * devicePixelRatio;
		
	    var context = canvas.getContext('2d');
	    context.clearRect(0, 0, canvas.width, canvas.height);
	    context.fillStyle = '#fff';

		let scale = canvas.width / 24;
		let offsetX = scale / 2;
		let offsetY = scale / 2;

		for (let i = 0; i < 216; i++) {
			let x = i % 24;
			let y = Math.floor(i / 24);

			if (isSpacer(x, y)) continue;
			if (data[i]) {
				context.globalAlpha = data[i] / 0xff;
				context.beginPath();
				context.arc((x * scale) + offsetX, (y * scale) + offsetY, scale / 8, 0, 2 * Math.PI);
				context.fill();
				context.globalAlpha = 1;
			}
		}
	});	
}


window.onresize = drawGlasses;

document.addEventListener("visibilitychange", () => {
	if (!document.hidden) {
		drawGlasses();
	}
});

