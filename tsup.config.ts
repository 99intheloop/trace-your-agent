import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    'hooks/subagent-stop': 'src/cli/hooks-script/subagent-stop.ts',
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
});
