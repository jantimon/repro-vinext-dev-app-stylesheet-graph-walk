// Generates a Pages Router app whose `_app` imports a tree of `modules` components
// Every 4th component imports a CSS module
// Usage: node scripts/generate.mjs [modules=2000]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const modules = Number(process.argv[2] ?? 2000);
const fanout = 8;

rmSync("pages", { recursive: true, force: true });
rmSync("components", { recursive: true, force: true });
mkdirSync("pages", { recursive: true });
mkdirSync("components", { recursive: true });

for (let m = 0; m < modules; m++) {
  const children = [];
  for (let c = m * fanout + 1; c <= m * fanout + fanout && c < modules; c++) children.push(c);
  const hasCss = m % 4 === 0;
  if (hasCss) writeFileSync(`components/m${m}.module.css`, `.box { padding: ${m % 16}px; }\n`);
  writeFileSync(
    `components/m${m}.jsx`,
    `${hasCss ? `import styles from "./m${m}.module.css";\n` : ""}${children.map((c) => `import M${c} from "./m${c}.jsx";\n`).join("")}
export default function M${m}() {
  return (
    <div${hasCss ? " className={styles.box}" : ""}>
      ${[`m${m}`, ...children.map((c) => `<M${c} />`)].join("\n      ")}
    </div>
  );
}
`,
  );
}

writeFileSync(
  "pages/_app.jsx",
  `import M0 from "../components/m0.jsx";

export default function App({ Component, pageProps }) {
  return (
    <>
      <M0 />
      <Component {...pageProps} />
    </>
  );
}
`,
);
writeFileSync(
  "pages/index.jsx",
  `export default function Home() {
  return <h1>home</h1>;
}

export function getServerSideProps() {
  return { props: {} };
}
`,
);

console.log(`generated ${modules} components, ${Math.ceil(modules / 4)} with a CSS module`);
