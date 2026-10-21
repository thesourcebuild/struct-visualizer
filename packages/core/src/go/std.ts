/**
 * Standard-library types that commonly appear in structs, written as their actual Go
 * definitions (unexported zero-size markers like noCopy omitted: they take no space). Layout is
 * derived from these per target, so e.g. time.Time is 24 bytes on 64-bit and 20 on 32-bit.
 *
 * Keyed by "import/path.Name". Names inside a definition are resolved within the std set
 * (sync.Mutex, atomic.Int32) by package short name. tests/go-compiler.test.ts checks each entry
 * against go/types.
 */
export interface StdType {
  source: string;
  /** Alignment forced regardless of target: sync/atomic's 64-bit types embed align64. */
  align?: number;
  typeParams?: string[];
}

export const GO_STD_TYPES: Record<string, StdType> = {
  'time.Time': { source: 'struct { wall uint64; ext int64; loc *Location }' },
  'time.Duration': { source: 'int64' },
  'time.Month': { source: 'int' },
  'time.Weekday': { source: 'int' },
  'time.Location': { source: 'struct { name string; zone []zone; tx []zoneTrans; extend string; cacheStart int64; cacheEnd int64; cacheZone *zone }' },

  'sync.Mutex': { source: 'struct { state int32; sema uint32 }' },
  'sync.RWMutex': { source: 'struct { w sync.Mutex; writerSem uint32; readerSem uint32; readerCount atomic.Int32; readerWait atomic.Int32 }' },
  'sync.Once': { source: 'struct { done atomic.Uint32; m sync.Mutex }' },
  'sync.WaitGroup': { source: 'struct { state atomic.Uint64; sema uint32 }' },

  'sync/atomic.Bool': { source: 'struct { v uint32 }' },
  'sync/atomic.Int32': { source: 'struct { v int32 }' },
  'sync/atomic.Uint32': { source: 'struct { v uint32 }' },
  'sync/atomic.Int64': { source: 'struct { v int64 }', align: 8 },
  'sync/atomic.Uint64': { source: 'struct { v uint64 }', align: 8 },
  'sync/atomic.Uintptr': { source: 'struct { v uintptr }' },
  'sync/atomic.Value': { source: 'struct { v any }' },
  'sync/atomic.Pointer': { source: 'struct { v unsafe.Pointer }', typeParams: ['T'] },

  'strings.Builder': { source: 'struct { addr *Builder; buf []byte }' },
  'bytes.Buffer': { source: 'struct { buf []byte; off int; lastRead int8 }' },
  'reflect.Value': { source: 'struct { typ_ unsafe.Pointer; ptr unsafe.Pointer; flag uintptr }' },
  'net.IP': { source: '[]byte' },
  'net/netip.Addr': { source: 'struct { addr struct { hi uint64; lo uint64 }; z unsafe.Pointer }' },

  'context.Context': { source: 'interface { Deadline() }' },
  'context.CancelFunc': { source: 'func()' },
  'io.Reader': { source: 'interface { Read() }' },
  'io.Writer': { source: 'interface { Write() }' },
  'io.ReadWriter': { source: 'interface { Read() }' },
  'io.Closer': { source: 'interface { Close() }' },
  'io.ReadCloser': { source: 'interface { Read() }' },
  'io.WriteCloser': { source: 'interface { Write() }' },
  'fmt.Stringer': { source: 'interface { String() }' },
  'reflect.Type': { source: 'interface { Name() }' },
  'net.Conn': { source: 'interface { Read() }' },
  'net.Addr': { source: 'interface { Network() }' },
  'net/http.Handler': { source: 'interface { ServeHTTP() }' },
  'log/slog.Logger': { source: 'struct { handler interface { Handle() } }' },
};

/** Default import path for a package short name used without an import (inside std sources). */
export const STD_PACKAGE_PATHS: Record<string, string> = {
  time: 'time',
  sync: 'sync',
  atomic: 'sync/atomic',
  strings: 'strings',
  bytes: 'bytes',
  reflect: 'reflect',
  net: 'net',
  netip: 'net/netip',
  context: 'context',
  io: 'io',
  fmt: 'fmt',
  http: 'net/http',
  slog: 'log/slog',
  unsafe: 'unsafe',
};
