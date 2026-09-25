/*---------------------------------------------------------------------------------------------
 *  Team Brain — Real-time Multiplayer Collaboration Contribution
 *  Phase 2.5: Narrow editor boundary sync for hello.js
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ISingleEditOperation } from '../../../../editor/common/core/editOperation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as WorkbenchExtensions, IWorkbenchContributionsRegistry } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
// @ts-ignore
import * as Y from './yjs.bundle.js';

const TARGET_ROOM = 'hello.js';
const RELAY_WS_URL = 'ws://localhost:4444';

class ModelCollabAdapter extends Disposable {
	private readonly _doc: Y.Doc;
	private readonly _ytext: Y.Text;
	private _ws: WebSocket | null = null;
	private _isRemoteApplying = false;

	constructor(
		private readonly _model: ITextModel,
		private readonly _room: string
	) {
		super();
		this._doc = new Y.Doc();
		this._ytext = this._doc.getText('content');

		console.log(`[CollabAdapter] Initialized adapter for [${this._room}] (${this._model.uri.toString()})`);

		this._setupWebSocket();
		this._setupLocalListener();
		this._setupYjsListener();

		// Cleanup on model disposal
		this._register(this._model.onWillDispose(() => {
			this.dispose();
		}));
	}

	private _setupWebSocket(): void {
		try {
			const ws = new WebSocket(`${RELAY_WS_URL}?room=${encodeURIComponent(this._room)}`);
			this._ws = ws;

			ws.onopen = () => {
				console.log(`[CollabAdapter] Connected to relay at ${RELAY_WS_URL} for room [${this._room}]`);
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if ((data.type === 'sync' || data.type === 'update') && data.update) {
						const binaryStr = atob(data.update);
						const bytes = new Uint8Array(binaryStr.length);
						for (let i = 0; i < binaryStr.length; i++) {
							bytes[i] = binaryStr.charCodeAt(i);
						}

						// Apply remote update to our Y.Doc
						Y.applyUpdate(this._doc, bytes, 'remote');

						// If initial sync and model differs, catch up model
						if (data.type === 'sync') {
							const yTextValue = this._ytext.toString();
							if (yTextValue.length > 0 && this._model.getValue() !== yTextValue) {
								this._isRemoteApplying = true;
								try {
									const fullRange = this._model.getFullModelRange();
									this._model.pushEditOperations([], [{ range: fullRange, text: yTextValue }], () => null);
								} finally {
									this._isRemoteApplying = false;
								}
							} else if (yTextValue.length === 0 && this._model.getValue().length > 0) {
								// First peer: seed Yjs document with existing file contents
								this._doc.transact(() => {
									this._ytext.insert(0, this._model.getValue());
								}, 'local');
							}
						}
					}
				} catch (err) {
					console.error('[CollabAdapter] Error handling incoming WS message:', err);
				}
			};

			ws.onerror = (err) => {
				console.warn('[CollabAdapter] WebSocket error:', err);
			};

			ws.onclose = () => {
				console.log(`[CollabAdapter] Disconnected from relay for room [${this._room}]`);
			};
		} catch (err) {
			console.error('[CollabAdapter] Failed to initialize WebSocket connection:', err);
		}
	}

	private _setupLocalListener(): void {
		// Listen to local typing in VS Code Monaco editor
		this._register(this._model.onDidChangeContent((event) => {
			// CRITICAL: Prevent feedback loop if this change originated from remote edit
			if (this._isRemoteApplying) {
				return;
			}

			// Apply changes in reverse offset order into Y.Text
			this._doc.transact(() => {
				const sortedChanges = event.changes.slice().sort((a, b) => b.rangeOffset - a.rangeOffset);
				for (const change of sortedChanges) {
					if (change.rangeLength > 0) {
						this._ytext.delete(change.rangeOffset, change.rangeLength);
					}
					if (change.text.length > 0) {
						this._ytext.insert(change.rangeOffset, change.text);
					}
				}
			}, 'local');
		}));
	}

	private _setupYjsListener(): void {
		// When local edits generate a Yjs update, send to relay
		this._doc.on('update', (update: Uint8Array, origin: unknown) => {
			if (origin === 'local' && this._ws && this._ws.readyState === WebSocket.OPEN) {
				let binaryStr = '';
				for (let i = 0; i < update.length; i++) {
					binaryStr += String.fromCharCode(update[i]);
				}
				const base64Update = btoa(binaryStr);
				this._ws.send(JSON.stringify({
					type: 'update',
					room: this._room,
					update: base64Update
				}));
			}
		});

		// When remote updates mutate Y.Text, apply them to VS Code ITextModel
		this._ytext.observe((event, transaction) => {
			if (transaction.origin === 'local') {
				return;
			}

			this._isRemoteApplying = true;
			try {
				let index = 0;
				const edits: ISingleEditOperation[] = [];

				for (const op of event.delta) {
					if (op.retain !== undefined) {
						index += op.retain;
					} else if (op.insert !== undefined) {
						const insertText = typeof op.insert === 'string' ? op.insert : '';
						const pos = this._model.getPositionAt(index);
						edits.push({
							range: new Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
							text: insertText
						});
						index += insertText.length;
					} else if (op.delete !== undefined) {
						const startPos = this._model.getPositionAt(index);
						const endPos = this._model.getPositionAt(index + op.delete);
						edits.push({
							range: new Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column),
							text: ''
						});
					}
				}

				if (edits.length > 0) {
					this._model.pushEditOperations([], edits, () => null);
				}
			} finally {
				this._isRemoteApplying = false;
			}
		});
	}

	public override dispose(): void {
		if (this._ws) {
			this._ws.close();
			this._ws = null;
		}
		this._doc.destroy();
		super.dispose();
		console.log(`[CollabAdapter] Disposed adapter for [${this._room}]`);
	}
}

export class CollaborationContribution extends Disposable {
	private readonly _attachedModels = new Map<string, ModelCollabAdapter>();

	constructor(
		@IModelService private readonly _modelService: IModelService
	) {
		super();

		// Attach to already loaded models (if any)
		for (const model of this._modelService.getModels()) {
			this._maybeAttach(model);
		}

		// Attach to newly created/opened models
		this._register(this._modelService.onModelAdded((model) => {
			this._maybeAttach(model);
		}));

		this._register(this._modelService.onModelRemoved((model) => {
			const uriStr = model.uri.toString();
			const adapter = this._attachedModels.get(uriStr);
			if (adapter) {
				adapter.dispose();
				this._attachedModels.delete(uriStr);
			}
		}));
	}

	private _maybeAttach(model: ITextModel): void {
		const path = model.uri.path;
		// Phase 2.5: Target room is specifically hello.js
		if (path.endsWith(`/${TARGET_ROOM}`) || path === TARGET_ROOM || path.endsWith(TARGET_ROOM)) {
			const uriStr = model.uri.toString();
			if (!this._attachedModels.has(uriStr)) {
				const adapter = new ModelCollabAdapter(model, TARGET_ROOM);
				this._attachedModels.set(uriStr, adapter);
			}
		}
	}

	public override dispose(): void {
		for (const adapter of this._attachedModels.values()) {
			adapter.dispose();
		}
		this._attachedModels.clear();
		super.dispose();
	}
}

// Register contribution with the workbench
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CollaborationContribution,
	LifecyclePhase.Restored
);
