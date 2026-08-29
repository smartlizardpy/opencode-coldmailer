/**
 * A minimal SMTP server that accepts everything and delivers nothing.
 *
 * The send path was the one part of this product with no end-to-end test, because testing it
 * appeared to require a real mailbox and a real recipient. It does not: nodemailer only needs
 * something on the other end of a socket that speaks enough SMTP to say yes. This accepts the
 * conversation, records the message, and drops it on the floor.
 *
 * Nothing here can deliver mail. There is no upstream connection of any kind.
 */
import { createServer, type Server, type Socket } from "node:net";

export interface SunkMessage {
  from: string;
  to: string[];
  /** The full DATA payload, headers and body, with dot-unstuffing applied. */
  data: string;
  header(name: string): string | undefined;
  /** The body as the recipient reads it, with the transfer encoding undone. */
  body(): string;
}

export interface SmtpSink {
  port: number;
  messages: SunkMessage[];
  /** Make the next transaction fail with this reply, once. */
  failNext(reply: string): void;
  close(): Promise<void>;
}

function parseMessage(from: string, to: string[], raw: string): SunkMessage {
  // RFC 5321 dot-stuffing: a line starting with '.' is sent as '..'.
  const data = raw.replace(/^\.\./gm, ".");
  const split = data.indexOf("\r\n\r\n");
  const headers = split === -1 ? data : data.slice(0, split);
  const bodyText = split === -1 ? "" : data.slice(split + 4);
  return {
    from, to, data,
    header(name) {
      // `$` is NOT the terminator: under /m it anchors to the end of a LINE, so a folded
      // header - which is exactly what a long UTF-8 subject becomes - is cut off after its
      // first line. Terminate on a newline not followed by whitespace, or the end of input.
      const re = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?:\\r?\\n(?![ \\t])|(?![\\s\\S]))`, "im");
      return re.exec(`${headers}\r\n`)?.[1].replace(/\r?\n[ \t]+/g, "").trim();
    },
    body() {
      // Any non-ASCII in the body - which for this product means most of it - is
      // quoted-printable on the wire. A test asserting on "Ankara maçları" should not have to
      // know that, and one that asserts on the raw form is testing the encoder, not the email.
      const enc = (this.header("Content-Transfer-Encoding") ?? "").toLowerCase();
      if (enc === "base64") return Buffer.from(bodyText.replace(/\r?\n/g, ""), "base64").toString("utf8");
      if (enc !== "quoted-printable") return bodyText;
      const unfolded = bodyText.replace(/=\r?\n/g, "");
      const bytes = Buffer.from(
        unfolded.replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
        "binary",
      );
      return bytes.toString("utf8");
    },
  };
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const messages: SunkMessage[] = [];
  let failNextReply: string | undefined;

  const server: Server = createServer((socket: Socket) => {
    let buffer = "";
    let inData = false;
    let dataLines: string[] = [];
    let from = "";
    let to: string[] = [];

    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 sink.local ESMTP");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\r\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            if (failNextReply) {
              const reply = failNextReply; failNextReply = undefined;
              say(reply);
            } else {
              messages.push(parseMessage(from, to, dataLines.join("\r\n")));
              say("250 2.0.0 Ok: queued as SINK");
            }
            dataLines = []; from = ""; to = [];
            continue;
          }
          dataLines.push(line);
          continue;
        }

        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "EHLO" || verb === "HELO") {
          // AUTH is advertised because the app always sends credentials; the sink never
          // checks them. There is nothing here worth authenticating to.
          say("250-sink.local");
          say("250-AUTH PLAIN LOGIN");
          say("250-8BITMIME");
          say("250 SMTPUTF8");
        } else if (verb === "AUTH") {
          say("235 2.7.0 Accepted");
        } else if (verb === "MAIL") {
          from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          say("250 2.1.0 Ok");
        } else if (verb === "RCPT") {
          const addr = /<([^>]*)>/.exec(line)?.[1] ?? "";
          if (failNextReply?.startsWith("55")) {
            const reply = failNextReply; failNextReply = undefined;
            say(reply);
          } else { to.push(addr); say("250 2.1.5 Ok"); }
        } else if (verb === "DATA") {
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "QUIT") {
          say("221 2.0.0 Bye"); socket.end();
        } else if (verb === "RSET") {
          dataLines = []; from = ""; to = []; say("250 2.0.0 Ok");
        } else {
          say("250 2.0.0 Ok");
        }
      }
    });
    socket.on("error", () => { /* a client hanging up mid-transaction is not a test failure */ });
  });

  const port: number = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });

  return {
    port, messages,
    failNext: (reply) => { failNextReply = reply; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
