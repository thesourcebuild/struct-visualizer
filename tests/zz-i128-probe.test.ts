import { it } from "vitest";
import { analyzeStruct } from "@sp/core";
const cases = [
  "struct S { char c; __int128 a; char d; unsigned __int128 u; signed __int128 s; __int128 unsigned v; };",
  "typedef __int128 I128; struct S { char c; __int128_t a; __uint128_t b; char d; I128 e; };",
  "struct S { char c; __int128 a : 100; unsigned __int128 b : 28; char d; unsigned __int128 e : 65; };",
  "struct S { char a[sizeof(__int128)]; char b[_Alignof(unsigned __int128)]; char c[(__int128)-1 < 0 ? 1 : 2]; char d[(int)(((unsigned __int128)1 << 100) >> 98)]; char e[sizeof(__uint128_t) + (__int128_t)1]; char z; };",
  "struct S { char c; __int128 a : 129; };",
];
it("i128", () => {
  for (const sel of [{ target: "intel-x64-amd", dataModel: "LP64", os: "linux" }, { target: "intel-x86", dataModel: "ILP32", os: "linux" }, { target: "intel-x64-amd", dataModel: "LLP64", os: "windows" }, { target: "8051-8bit", dataModel: "SDCC", os: "none" }] as const) {
    for (const c of cases) {
      const a = analyzeStruct(c, sel as never);
      console.log("I128", sel.target, sel.os, a.errors.map((e) => e.message).join("; ") || `${a.result?.totalSize}/${a.result?.struct.alignment} ${a.result?.members.map((m) => `${m.member.name}@${m.offset}${m.bitOffset !== undefined ? "." + m.bitOffset : ""}`).join(" ")}`);
    }
  }
});
