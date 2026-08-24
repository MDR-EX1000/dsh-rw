// dsh-rw — known_hosts verification and learning.
//
// Supports the OpenSSH known_hosts line format:
//   host[,host2...] keytype base64 [comment]
//   [host]:port keytype base64          (non-default ports)
//   |1|saltB64|hashB64 keytype base64   (HASHED_HOSTS; HMAC-SHA1 of the
//                                        hostname keyed by the decoded salt)
// Marker lines (@cert-authority / @revoked), comments and blanks are skipped.
// accept() always appends plain (unhashed) lines.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Match one known_hosts host pattern against a candidate name. */
function patternMatches(pattern, candidate) {
    if (pattern.startsWith('|1|')) {
        const parts = pattern.split('|'); // ['', '1', saltB64, hashB64]
        if (parts.length !== 4)
            return false;
        const salt = Buffer.from(parts[2] ?? '', 'base64');
        const expected = Buffer.from(parts[3] ?? '', 'base64');
        if (salt.length === 0 || expected.length === 0)
            return false;
        const actual = createHmac('sha1', salt).update(candidate, 'utf8').digest();
        return actual.length === expected.length && timingSafeEqual(actual, expected);
    }
    return pattern === candidate;
}
function parseLines(text) {
    const out = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('@'))
            continue;
        const tokens = line.split(/\s+/);
        if (tokens.length < 3)
            continue;
        const [hosts, keyType, base64] = tokens;
        out.push({ patterns: hosts.split(','), keyType, base64 });
    }
    return out;
}
export class KnownHosts {
    path;
    constructor(path) {
        this.path = path;
    }
    static defaultPath() {
        return join(homedir(), '.ssh', 'known_hosts');
    }
    load() {
        let text;
        try {
            text = readFileSync(this.path, 'utf8');
        }
        catch {
            return []; // missing/unreadable file → nothing known
        }
        return parseLines(text);
    }
    /**
     * Candidate names for a connection: `[host]:port` is the canonical form
     * for non-22 ports, but we also try the plain name (some tools record it
     * that way); port 22 is always recorded plain.
     */
    static candidates(host, port) {
        return port === 22 ? [host] : [`[${host}]:${port}`, host];
    }
    verify(host, port, keyType, keyBase64) {
        const candidates = KnownHosts.candidates(host, port);
        const hostMatches = this.load().filter((e) => e.patterns.some((p) => candidates.some((c) => patternMatches(p, c))));
        const sameType = hostMatches.filter((e) => e.keyType === keyType);
        if (sameType.length === 0)
            return 'unknown';
        return sameType.some((e) => e.base64 === keyBase64) ? 'match' : 'changed';
    }
    /** Append a plain entry; exact duplicates (host+keyType+base64) are skipped. */
    accept(host, port, keyType, keyBase64) {
        const name = port === 22 ? host : `[${host}]:${port}`;
        const dup = this.load().some((e) => e.keyType === keyType &&
            e.base64 === keyBase64 &&
            e.patterns.some((p) => patternMatches(p, name)));
        if (dup)
            return;
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        let prefix = '';
        try {
            if (statSync(this.path).size > 0) {
                const text = readFileSync(this.path, 'utf8');
                if (!text.endsWith('\n'))
                    prefix = '\n';
            }
        }
        catch {
            // file does not exist yet — appendFileSync creates it
        }
        appendFileSync(this.path, `${prefix}${name} ${keyType} ${keyBase64}\n`);
        chmodSync(this.path, 0o600);
    }
}
