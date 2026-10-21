# Reporting an issue

Open issues at [github.com/thesourcebuild/structvisualizer/issues](https://github.com/thesourcebuild/structvisualizer/issues). Search the open and closed issues first; someone may already have reported it.

## Wrong layout

A size, offset or alignment that differs from the real compiler is the most useful report. Include:

1. **The share link.** Click **Copy share link** in the workbench and paste the URL. It holds the source, language, target and options, so it reproduces exactly what you saw.
2. **The compiler's output.** Run the program from the Verification Code tool on your toolchain and paste what it prints.
3. **The compiler and target:** for example `gcc 13.2 x86_64-linux-gnu`, `go1.27 GOARCH=386` or `rustc 1.99 thumbv7em-none-eabihf`.
4. **The smallest type that still shows the difference**, if you can cut it down.

Check the [Limitations](../README.md#limitations) first: some features, such as C++ inheritance or Rust `cfg` attributes, are not modelled.

## Parse errors

If valid code gives SP000, GO000 or RS000, include the share link and the code that fails. If the compiler accepts the code, say so.

## Anything else

For a UI problem, include the browser, OS, theme and a screenshot. For a feature request, describe what you want to lay out and why the current tools do not cover it.
