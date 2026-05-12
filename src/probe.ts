import "dotenv/config";
import { MiroMcpClient } from "./miro.js";

async function main() {
  const boardId = process.env.MIRO_BOARD_ID!;
  const miro = new MiroMcpClient();
  await miro.connect();

  const dsl = [
    "graphdir TB",
    "palette #fff6b6",
    "",
    "n1 backslash-n: Hello\\nWorld flowchart-process 0",
    "n2 html-br: Hello<br>World flowchart-process 0",
    "n3 html-br-slash: Hello<br/>World flowchart-process 0",
    "n4 unicode-sep: Hello World flowchart-process 0",
    "",
    "c n1 - n2",
    "c n2 - n3",
    "c n3 - n4",
  ].join("\n");

  await miro.createFlowchart({
    boardId,
    dsl,
    title: "PROBE — newline escapes",
  });
  console.log("Probe diagram created. Check the board: which renders multi-line?");
  await miro.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
