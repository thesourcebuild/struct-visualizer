/**
 * Go samples for the Go tool family. Each lays out its last struct type.
 *
 * The first ones are the C examples written in Go (same names, same fields), so a layout can be
 * compared across languages. C examples that need unions have no Go version: Go has no unions.
 */
export interface GoExample {
  name: string;
  code: string;
}

export const goExamples: readonly GoExample[] = [
  // ---- The C examples, in Go
  {
    name: 'Basic Struct',
    code: `package main

type Example struct {
	a byte
	b int32
	c byte
	d float64
}`,
  },
  {
    name: 'Optimized Struct',
    code: `package main

type Optimized struct {
	d float64
	b int32
	a byte
	c byte
}`,
  },
  {
    name: 'Nested Struct',
    code: `package main

type Inner struct {
	x byte
	y int32
}

type Outer struct {
	a     byte
	inner Inner
	b     byte
}`,
  },
  {
    name: 'Array Members',
    code: `package main

type ArrayExample struct {
	name   [32]byte
	id     int32
	values [4]float32
	flag   byte
}`,
  },
  {
    name: 'Pointer Members',
    code: `package main

import "unsafe"

type Pointers struct {
	a    byte
	ptr1 *int32
	b    byte
	ptr2 unsafe.Pointer // void *
	c    int16
}`,
  },
  {
    name: 'Advanced Pointers (Double + Function)',
    code: `package main

type CallbackContext struct {
	id  int32
	tag byte
}

type AdvancedPointers struct {
	matrix  **int32
	handler func(code int32, ctx *CallbackContext)
	context *CallbackContext
	flag    byte
}`,
  },
  {
    name: 'Enum Members',
    code: `package main

// Go has no enum type: a named integer type and constants play its role.
// int32 matches the size of a C enum.
type Color int32

const (
	ColorRed   Color = 0
	ColorGreen Color = 2
	ColorBlue  Color = 3
)

type Paint struct {
	color   Color
	opacity uint8
	label   [8]byte
}`,
  },
  {
    name: 'Typedef Enum Members',
    code: `package main

type Mode uint32

const (
	ModeOff Mode = iota
	ModeOn
)

type Level int32

const (
	LevelLow  Level = 1
	LevelHigh Level = 3
)

// An alias, like C's typedef.
type LevelT = Level

type Device struct {
	mode  Mode
	level LevelT
	data  [2]int32
}`,
  },
  {
    name: 'Bit Flags (instead of bit-fields)',
    code: `package main

// Go has no bit-fields: pack them into an integer and mask.
// flags holds mode (3 bits), state (5), enabled (1) and error (7).
type BitfieldComplex struct {
	id      uint32
	flags   uint16
	counter uint16
	tag     byte
}`,
  },

  // ---- Go-specific
  {
    name: 'Strings, slices and maps',
    code: `package main

type User struct {
	Active  bool
	Name    string
	Age     uint8
	Tags    []string
	Admin   bool
	Meta    map[string]any
	Visits  int32
}`,
  },
  {
    name: 'Embedded and nested structs',
    code: `package main

import "time"

type Base struct {
	ID      uint32
	Deleted bool
}

type Order struct {
	Base
	Paid     bool
	Created  time.Time
	Total    float64
	Shipping struct {
		Express bool
		Weight  float32
	}
	Items uint16
}`,
  },
  {
    name: 'Arrays and constants',
    code: `package main

const (
	KeySize = 1 << 5
	Slots   = 4
)

type Packet struct {
	Flags   uint8
	Key     [KeySize]byte
	Seq     uint64
	Ports   [Slots]uint16
	Valid   bool
}`,
  },
  {
    name: 'sync/atomic on 32-bit',
    code: `package main

import (
	"sync"
	"sync/atomic"
)

type Stats struct {
	mu      sync.Mutex
	enabled bool
	hits    uint64 // atomic.AddUint64 needs 8-byte alignment on 386 and arm
	misses  atomic.Uint64
	name    string
}`,
  },
  {
    name: 'Trailing zero-size field',
    code: `package main

type Header struct {
	Length uint32
	Kind   uint16
	_      [0]func() // makes Header non-comparable, but costs padding at the end
}`,
  },
  {
    name: 'Generic instantiation',
    code: `package main

type Pair[K comparable, V any] struct {
	Key   K
	Value V
}

type Cache struct {
	hits  int32
	entry Pair[string, int64]
	ok    bool
	next  *Cache
}`,
  },
  {
    name: 'Interfaces, channels and funcs',
    code: `package main

import (
	"context"
	"io"
)

type Worker struct {
	ready   bool
	ctx     context.Context
	out     io.Writer
	retries uint8
	jobs    chan int
	done    func(error)
	err     error
}`,
  },
];
