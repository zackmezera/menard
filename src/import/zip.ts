/**
 * A minimal ZIP reader for EPUBs: stored and deflated entries, read through
 * the central directory, inflated with the platform's DecompressionStream.
 * No dependencies; works wherever Chromium's streams do (desktop and mobile).
 * Owner: import module. DESIGN.md §16.
 *
 * ponytail: no ZIP64, no encryption, no multi-disk archives; EPUBs never need them.
 */
export interface ZipArchive {
	names(): string[];
	/** The entry's bytes, or null when the archive has no such entry. */
	read(name: string): Promise<Uint8Array | null>;
	/** The entry decoded as UTF-8 text, or null. */
	text(name: string): Promise<string | null>;
}

interface Entry {
	method: number;
	compressedSize: number;
	localOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export function openZip(bytes: Uint8Array): ZipArchive {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries = readDirectory(bytes, view);
	const decoder = new TextDecoder("utf-8");
	const read = async (name: string): Promise<Uint8Array | null> => {
		const entry = entries.get(name);
		if (!entry) return null;
		const at = entry.localOffset;
		if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_SIGNATURE) throw bad(`bad local header for ${name}`);
		const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
		const data = bytes.subarray(start, start + entry.compressedSize);
		if (entry.method === 0) return data;
		if (entry.method === 8) return inflateRaw(data);
		throw bad(`${name} uses unsupported compression method ${entry.method}`);
	};
	return {
		names: () => [...entries.keys()],
		read,
		text: async (name) => {
			const data = await read(name);
			return data === null ? null : decoder.decode(data);
		},
	};
}

function readDirectory(bytes: Uint8Array, view: DataView): Map<string, Entry> {
	// The end-of-central-directory record sits in the last 22 + up to 65535 (comment) bytes.
	let eocd = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
		if (view.getUint32(at, true) === EOCD_SIGNATURE) {
			eocd = at;
			break;
		}
	}
	if (eocd < 0) throw bad("not a zip archive");
	const count = view.getUint16(eocd + 10, true);
	let at = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder("utf-8");
	const entries = new Map<string, Entry>();
	for (let i = 0; i < count; i++) {
		if (at + 46 > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) throw bad("bad central directory");
		const nameLength = view.getUint16(at + 28, true);
		const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
		entries.set(name, {
			method: view.getUint16(at + 10, true),
			compressedSize: view.getUint32(at + 20, true),
			localOffset: view.getUint32(at + 42, true),
		});
		at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
	}
	return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bad(detail: string): Error {
	return new Error(`This file could not be read as an EPUB: ${detail}.`);
}
