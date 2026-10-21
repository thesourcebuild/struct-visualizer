// Data Models for struct padding calculator
// Defines Data Models (LP32, ILP32, LP64, etc), Target Architectures, and OS Types
import type { Architecture, PackingRules } from '../types';

export type DataModel = 'LP32' | 'ILP32' | 'ILP32LL' | 'ILP32LL64' | 'LP64' | 'LLP64' | 'ILP64' | 'SILP64' | 'XC8' | 'XC16' | 'XC32' | 'C51' | 'SDCC';
export type TargetArchitecture = 'intel-x86' | 'intel-x64-amd' | 'arm32' | 'arm64' | 'microchip-8bit' | 'microchip-16bit' | 'microchip-32bit' | '8051-8bit' | 'riscv32' | 'riscv64';
export type OSType = 'windows' | 'linux' | 'none';

export interface DataModelInfo {
    id: DataModel;
    name: string;
    displayName: string;
    description: string;
    alias?: string[];
    dataTypes: {
        shortSize: number;
        intSize: number;
        longSize: number;
        longLongSize: number;
        pointerSize: number;
        floatSize: number;
        doubleSize: number;
        enumSize: number;
    };
}

export interface TargetArchitectureInfo {
    id: TargetArchitecture;
    name: string;
    displayName: string;
    description: string;
    supportedOSTypes: OSType[];
}

export interface OSTypeInfo {
    id: OSType;
    name: string;
    displayName: string;
    description: string;
}

// Data Model Definitions
export const dataModels: Record<DataModel, DataModelInfo> = {
    LP32: {
        id: 'LP32',
        name: 'LP32',
        displayName: 'LP32',
        description: 'Long and pointers are 32-bit. Common on older systems (Windows 3.1, PDP-11, VAX).',
        dataTypes: {
            shortSize: 2,
            intSize: 2,
            longSize: 4,
            longLongSize: 8, // Assumming it to be 8. As, officialy their is no long long for ILP32
            pointerSize: 4,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    ILP32: {
        id: 'ILP32',
        name: 'ILP32',
        displayName: 'ILP32',
        description: 'Int, long, and pointers are 32-bit. Common on 32-bit systems (Win32, x32, i386 OSX, IBM 370, VAX Unix).',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 4,
            longLongSize: 8, // Assumming it to be 8. As, officialy their is no long long for ILP32
            pointerSize: 4,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    ILP32LL: {
        id: 'ILP32LL',
        name: 'ILP32LL',
        displayName: 'ILP32LL',
        description: 'ILP32 with long long aligned to 8-byte boundary. Variant used in some x86 Windows environments.',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 4,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    ILP32LL64: {
        id: 'ILP32LL64',
        name: 'ILP32LL64',
        displayName: 'ILP32LL64',
        description: 'ILP32 hybrid with 64-bit pointers. Rare Windows x86 variant with mixed int/pointer sizing.',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 8,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    LP64: {
        id: 'LP64',
        name: 'LP64',
        alias: ['I32LP64'],
        displayName: 'LP64',
        description: 'Long and pointers are 64-bit. Common on UNIX/Linux 64-bit systems.',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 8,
            longLongSize: 8,
            pointerSize: 8,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    LLP64: {
        id: 'LLP64',
        name: 'LLP64',
        alias: ['IL32LLP64', 'P64'],
        displayName: 'LLP64',
        description: 'Long long and pointers are 64-bit. Used on Windows 64-bit (Microsoft Win64).',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 8,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    ILP64: {
        id: 'ILP64',
        name: 'ILP64',
        displayName: 'ILP64',
        description: 'Int, long, and pointers are 64-bit. Rarely used in practice.',
        dataTypes: {
            shortSize: 2,
            intSize: 8,
            longSize: 8,
            longLongSize: 8,
            pointerSize: 8,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 8,
        },
    },
    SILP64: {
        id: 'SILP64',
        name: 'SILP64',
        displayName: 'SILP64',
        description: 'Short, int, long, and pointers are all 64-bit. Used on some exotic systems (UNICOS).',
        dataTypes: {
            shortSize: 8,
            intSize: 8,
            longSize: 8,
            longLongSize: 8,
            pointerSize: 8,
            floatSize: 8,
            doubleSize: 8,
            enumSize: 8,
        },
    },
    XC8: {
        id: 'XC8',
        name: 'XC8',
        displayName: 'XC8 (AVR)',
        description: 'Microchip XC8 for AVR, built on avr-gcc: short=2, int=2, long=4, long long=8, float=double=4, pointers=2, everything 1-byte aligned.',
        dataTypes: {
            shortSize: 2,
            intSize: 2,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 2,
            floatSize: 4,
            doubleSize: 4,
            enumSize: 2,
        },
    },
    XC16: {
        id: 'XC16',
        name: 'XC16',
        displayName: 'XC16 (16-bit PIC)',
        description: 'Microchip XC16 compiler for 16-bit PIC microcontrollers. short=2, int=2, long=4, long long=4.',
        dataTypes: {
            shortSize: 2,
            intSize: 2,
            longSize: 4,
            longLongSize: 4,
            pointerSize: 2,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 2,
        },
    },
    XC32: {
        id: 'XC32',
        name: 'XC32',
        displayName: 'XC32 (32-bit PIC)',
        description: 'Microchip XC32 compiler for 32-bit PIC microcontrollers. short=2, int=4, long=4, long long=8.',
        dataTypes: {
            shortSize: 2,
            intSize: 4,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 4,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 4,
        },
    },
    C51: {
        id: 'C51',
        name: 'C51',
        displayName: 'C51 (Keil)',
        description: 'Keil C51 compiler for 8051 microcontrollers. Typical: short=2, int=2, long=4, pointers=2.',
        dataTypes: {
            shortSize: 2,
            intSize: 2,
            longSize: 4,
            longLongSize: 8,
            pointerSize: 2,
            floatSize: 4,
            doubleSize: 8,
            enumSize: 2,
        },
    },
    SDCC: {
        id: 'SDCC',
        name: 'SDCC',
        displayName: 'SDCC (Small Device C Compiler)',
        description: 'SDCC for the 8051 (mcs51): short=2, int=2, long=4, long long=8, float=double=4, generic pointers=3.',
        dataTypes: {
            shortSize: 2,
            intSize: 2,
            longSize: 4,
            longLongSize: 8,
            // A generic pointer carries a byte saying which memory space it points into.
            pointerSize: 3,
            floatSize: 4,
            doubleSize: 4,
            enumSize: 2,
        },
    },
};

export const dataModelList: DataModelInfo[] = [
    dataModels.LP32,
    dataModels.ILP32,
    dataModels.ILP32LL,
    dataModels.ILP32LL64,
    dataModels.LP64,
    dataModels.LLP64,
    dataModels.ILP64,
    dataModels.SILP64,
    dataModels.XC8,
    dataModels.XC16,
    dataModels.XC32,
    dataModels.C51,
    dataModels.SDCC,
];

// Target Architecture Definitions
export const targetArchitectures: Record<TargetArchitecture, TargetArchitectureInfo> = {
    'intel-x86': {
        id: 'intel-x86',
        name: 'intel-x86',
        displayName: 'Intel x86 (32-bit)',
        description: 'Standard 32-bit x86 architecture (IA-32)',
        supportedOSTypes: ['windows', 'linux'],
    },
    'intel-x64-amd': {
        id: 'intel-x64-amd',
        name: 'intel-x64-amd',
        displayName: 'Intel x86_x64 / AMD64',
        description: '64-bit x86-64 architecture (AMD64/Intel 64)',
        supportedOSTypes: ['windows', 'linux'],
    },
    arm32: {
        id: 'arm32',
        name: 'arm32',
        displayName: 'ARM32 (ARMv7)',
        description: '32-bit ARM Thumb architecture',
        supportedOSTypes: ['linux', 'none'],
    },
    arm64: {
        id: 'arm64',
        name: 'arm64',
        displayName: 'ARM64 (AARCH64)',
        description: '64-bit ARM architecture (AARCH64)',
        supportedOSTypes: ['linux', 'none'],
    },
    'microchip-8bit': {
        id: 'microchip-8bit',
        name: 'microchip-8bit',
        displayName: 'Microchip 8-bit',
        description: 'Microchip 8-bit microcontroller',
        supportedOSTypes: ['none'],
    },
    'microchip-16bit': {
        id: 'microchip-16bit',
        name: 'microchip-16bit',
        displayName: 'Microchip 16-bit',
        description: 'Microchip 16-bit microcontroller',
        supportedOSTypes: ['none'],
    },
    'microchip-32bit': {
        id: 'microchip-32bit',
        name: 'microchip-32bit',
        displayName: 'Microchip 32-bit',
        description: 'Microchip 32-bit microcontroller',
        supportedOSTypes: ['none'],
    },
    '8051-8bit': {
        id: '8051-8bit',
        name: '8051-8bit',
        displayName: '8051 8-bit',
        description: '8051 8-bit microcontroller',
        supportedOSTypes: ['none'],
    },
    riscv32: {
        id: 'riscv32',
        name: 'riscv32',
        displayName: 'RISC-V 32-bit',
        description: 'RISC-V 32-bit architecture (RV32)',
        supportedOSTypes: ['linux', 'none'],
    },
    riscv64: {
        id: 'riscv64',
        name: 'riscv64',
        displayName: 'RISC-V 64-bit',
        description: 'RISC-V 64-bit architecture (RV64)',
        supportedOSTypes: ['linux', 'none'],
    },
};

export const targetArchitectureList: TargetArchitectureInfo[] = [
    targetArchitectures['intel-x86'],
    targetArchitectures['intel-x64-amd'],
    targetArchitectures.arm32,
    targetArchitectures.arm64,
    targetArchitectures['microchip-8bit'],
    targetArchitectures['microchip-16bit'],
    targetArchitectures['microchip-32bit'],
    targetArchitectures['8051-8bit'],
    targetArchitectures.riscv32,
    targetArchitectures.riscv64,
];

// OS Type Definitions
export const osTypes: Record<OSType, OSTypeInfo> = {
    windows: {
        id: 'windows',
        name: 'windows',
        displayName: 'Windows',
        description: 'Windows operating system',
    },
    linux: {
        id: 'linux',
        name: 'linux',
        displayName: 'Linux',
        description: 'Linux operating system',
    },
    none: {
        id: 'none',
        name: 'none',
        displayName: 'None (Bare Metal)',
        description: 'No operating system (bare metal / embedded)',
    },
};

export const osTypeList: OSTypeInfo[] = [
    osTypes.windows,
    osTypes.linux,
    osTypes.none,
];

// Mapping from (DataModel, TargetArchitecture, OSType) to Architecture ID
// This maps the three dropdown selections to the internal architecture ID
// Only includes valid combinations (UI filters invalid ones)
export const architectureMapping: Record<string, string> = {
    // Intel x86 (32-bit) - LP32, ILP32, ILP32LL, and ILP32LL64 data models
    'LP32-intel-x86-windows': 'x86',
    'LP32-intel-x86-linux': 'x86',
    'ILP32-intel-x86-windows': 'x86',
    'ILP32-intel-x86-linux': 'x86',
    'ILP32LL-intel-x86-windows': 'x86',
    'ILP32LL-intel-x86-linux': 'x86',
    'ILP32LL64-intel-x86-windows': 'x86',
    'ILP32LL64-intel-x86-linux': 'x86',

    // Intel x86_x64/AMD (64-bit) - LP64, LLP64, ILP64, SILP64 data models
    'LP64-intel-x64-amd-linux': 'x64',
    'LP64-intel-x64-amd-windows': 'x64',
    'LLP64-intel-x64-amd-windows': 'x64',
    'LLP64-intel-x64-amd-linux': 'x64',
    'ILP64-intel-x64-amd-linux': 'x64',
    'ILP64-intel-x64-amd-windows': 'x64',
    'SILP64-intel-x64-amd-linux': 'x64',
    'SILP64-intel-x64-amd-windows': 'x64',

    // ARM32 (32-bit) - ILP32 data model
    'ILP32-arm32-linux': 'arm32',
    'ILP32-arm32-none': 'arm32',

    // ARM64 (AArch64) (64-bit) - LP64, LLP64, ILP64, SILP64 data models
    'LP64-arm64-linux': 'arm64',
    'LP64-arm64-none': 'arm64',
    'LLP64-arm64-linux': 'arm64',
    'LLP64-arm64-none': 'arm64',
    'ILP64-arm64-linux': 'arm64',
    'ILP64-arm64-none': 'arm64',
    'SILP64-arm64-linux': 'arm64',
    'SILP64-arm64-none': 'arm64',

    // Microchip and 8051 bare metal compiler models
    'XC8-microchip-8bit-none': 'avr',
    'XC16-microchip-16bit-none': 'pic16',
    'ILP32-microchip-32bit-none': 'pic32',
    'XC32-microchip-32bit-none': 'pic32',
    'C51-8051-8bit-none': '8051',
    'SDCC-8051-8bit-none': '8051',

    // RISC-V 32-bit - ILP32 data model
    'ILP32-riscv32-linux': 'riscv32',
    'ILP32-riscv32-none': 'riscv32',

    // RISC-V 64-bit - LP64, LLP64, ILP64, SILP64 data models
    'LP64-riscv64-linux': 'riscv64',
    'LP64-riscv64-none': 'riscv64',
    'LLP64-riscv64-linux': 'riscv64',
    'LLP64-riscv64-none': 'riscv64',
    'ILP64-riscv64-linux': 'riscv64',
    'ILP64-riscv64-none': 'riscv64',
    'SILP64-riscv64-linux': 'riscv64',
    'SILP64-riscv64-none': 'riscv64',
};

/**
 * Get the architecture ID for a given combination of Data Model, Target Architecture, and OS Type
 */
export function getArchitectureId(
    dataModel: DataModel,
    targetArchitecture: TargetArchitecture,
    osType: OSType
): string {
    const key = `${dataModel}-${targetArchitecture}-${osType}`;
    const mapped = architectureMapping[key];
    if (mapped) return mapped;

    const fallbackByTarget: Record<TargetArchitecture, string> = {
        'intel-x86': 'x86',
        'intel-x64-amd': 'x64',
        arm32: 'arm32',
        arm64: 'arm64',
        'microchip-8bit': 'avr',
        'microchip-16bit': 'pic16',
        'microchip-32bit': 'pic32',
        '8051-8bit': '8051',
        riscv32: 'riscv32',
        riscv64: 'riscv64',
    };

    // Fall back to the target's own base architecture rather than an unrelated ABI.
    return fallbackByTarget[targetArchitecture];
}

/**
 * Check if an OS Type is supported by a Target Architecture
 */
export function isOSTypeSupportedByArchitecture(
    targetArchitecture: TargetArchitecture,
    osType: OSType
): boolean {
    const arch = targetArchitectures[targetArchitecture];
    return arch?.supportedOSTypes?.includes(osType) ?? false;
}

/**
 * Get supported OS types for a target architecture
 */
export function getSupportedOSTypes(targetArchitecture: TargetArchitecture): OSType[] {
    return targetArchitectures[targetArchitecture]?.supportedOSTypes ?? ['none'];
}

/**
 * Get valid data models for a given target architecture
 * Different architectures only support certain data models based on their bit width
 */
export function getValidDataModelsForArchitecture(targetArchitecture: TargetArchitecture): DataModel[] {
    switch (targetArchitecture) {
        // 32-bit architectures: only support 32-bit data models
        case 'intel-x86':
            return ['ILP32', 'ILP32LL', 'ILP32LL64', 'LP32'];

        // 64-bit architectures: only support 64-bit data models
        case 'intel-x64-amd':
            return ['LP64', 'LLP64', 'ILP64', 'SILP64'];

        case 'arm32':
            return ['ILP32'];

        case 'arm64':
            return ['LP64', 'LLP64', 'ILP64'];

        // RISC-V 32-bit: only support 32-bit data models
        case 'riscv32':
            return ['ILP32'];

        // RISC-V 64-bit: only support 64-bit data models
        case 'riscv64':
            return ['LP64', 'LLP64', 'ILP64', 'SILP64'];

        // Microchip 8-bit: XC8 compiler model
        case 'microchip-8bit':
            return ['XC8'];

        // Microchip 16-bit: XC16 compiler model
        case 'microchip-16bit':
            return ['XC16'];

        // Microchip 32-bit: XC32 compiler model
        case 'microchip-32bit':
            return ['XC32', 'ILP32'];

        // 8051 bare metal: provide C51 and SDCC compiler models plus ILP32 fallback
        case '8051-8bit':
            return ['C51', 'SDCC'];

        default:
            return [];
    }
}

/**
 * Get the default data model for a given target architecture
 */
export function getDefaultDataModelForArchitecture(targetArchitecture: TargetArchitecture): DataModel {
    const validModels = getValidDataModelsForArchitecture(targetArchitecture);
    return validModels.length > 0 ? validModels[0] : 'ILP32';
}

/**
 * Check if a target architecture is bare metal/embedded (Data Model not applicable)
 * Note: Microchip and 8051 have ILP32 as a default, so they are not considered "bare metal" for UI purposes
 */
export function isBaremetalArchitecture(targetArchitecture: TargetArchitecture): boolean {
    const os = getSupportedOSTypes(targetArchitecture);
    return os.length === 1 && os[0] === 'none';
}

/**
 * Get standard C type mappings for a given data model
 * Returns size and alignment for standard C types based on the selected data model
 */
export function getStandardTypeMap(dataModel: DataModel): Record<string, { size: number; alignment: number }> {
    const model = dataModels[dataModel];
    if (!model) {
        return {};
    }

    return {
        'void': { size: 0, alignment: 1 },
        'char': { size: 1, alignment: 1 },
        'signed char': { size: 1, alignment: 1 },
        'unsigned char': { size: 1, alignment: 1 },
        'int8_t': { size: 1, alignment: 1 },
        'uint8_t': { size: 1, alignment: 1 },
        'u8': { size: 1, alignment: 1 },
        'i8': { size: 1, alignment: 1 },
        'short': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'unsigned short': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'int16_t': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'uint16_t': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'u16': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'i16': { size: model.dataTypes.shortSize, alignment: model.dataTypes.shortSize },
        'int': { size: model.dataTypes.intSize, alignment: model.dataTypes.intSize },
        'unsigned int': { size: model.dataTypes.intSize, alignment: model.dataTypes.intSize },
        'int32_t': { size: 4, alignment: 4 },
        'uint32_t': { size: 4, alignment: 4 },
        'u32': { size: 4, alignment: 4 },
        'i32': { size: 4, alignment: 4 },
        'long': { size: model.dataTypes.longSize, alignment: model.dataTypes.longSize },
        'unsigned long': { size: model.dataTypes.longSize, alignment: model.dataTypes.longSize },
        'long long': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'unsigned long long': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'int64_t': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'uint64_t': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'u64': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'i64': { size: model.dataTypes.longLongSize, alignment: model.dataTypes.longLongSize },
        'float': { size: model.dataTypes.floatSize, alignment: model.dataTypes.floatSize },
        'float32': { size: 4, alignment: 4 },
        'f32': { size: 4, alignment: 4 },
        'double': { size: model.dataTypes.doubleSize, alignment: model.dataTypes.doubleSize },
        'float64': { size: model.dataTypes.doubleSize, alignment: model.dataTypes.doubleSize },
        'f64': { size: model.dataTypes.doubleSize, alignment: model.dataTypes.doubleSize },
        'long double': { size: model.dataTypes.doubleSize, alignment: model.dataTypes.doubleSize },
        'size_t': { size: model.dataTypes.pointerSize, alignment: model.dataTypes.pointerSize },
        'ssize_t': { size: model.dataTypes.pointerSize, alignment: model.dataTypes.pointerSize },
        'intptr_t': { size: model.dataTypes.pointerSize, alignment: model.dataTypes.pointerSize },
        'uintptr_t': { size: model.dataTypes.pointerSize, alignment: model.dataTypes.pointerSize },
        'ptrdiff_t': { size: model.dataTypes.pointerSize, alignment: model.dataTypes.pointerSize },
        'bool': { size: 1, alignment: 1 },
        '_Bool': { size: 1, alignment: 1 },
        // wchar_t is 16-bit on Windows (LLP64) and 32-bit on Unix-like and most embedded ABIs.
        'wchar_t': dataModel === 'LLP64' ? { size: 2, alignment: 2 } : { size: 4, alignment: 4 },
        'char8_t': { size: 1, alignment: 1 },
        'char16_t': { size: 2, alignment: 2 },
        'char32_t': { size: 4, alignment: 4 },
        'enum': { size: model.dataTypes.enumSize, alignment: model.dataTypes.enumSize },
    };
}

export type ResolvedArchitecture = Architecture & {
    pointerSize: number;
    defaultAlignment: number;
    packingRules: PackingRules;
};

/**
 * Resolve layout settings (pointer size, alignments, packing rules) from
 * Data Model + Target + OS. This keeps ABI-oriented defaults in one place.
 */
export function resolveArchitectureForSelection(
    baseArchitecture: Architecture,
    dataModel: DataModel,
    targetArchitecture: TargetArchitecture,
    osType: OSType
): ResolvedArchitecture {
    const model = dataModels[dataModel];
    const pointerSize = model?.dataTypes.pointerSize ?? baseArchitecture.pointerSize ?? 8;

    let defaultAlignment = baseArchitecture.defaultAlignment ?? pointerSize;
    let maxAlignment = baseArchitecture.maxAlignment;
    let packingRules: PackingRules = baseArchitecture.packingRules
        ? { ...baseArchitecture.packingRules }
        : { structAlignment: 'max', paddingAlignment: true };
    let dataTypes = baseArchitecture.dataTypes ? { ...baseArchitecture.dataTypes } : undefined;

    switch (targetArchitecture) {
        case 'intel-x86':
            defaultAlignment = 4;
            maxAlignment = 8;
            packingRules = { structAlignment: 'max', paddingAlignment: true };
            if (osType === 'linux') {
                // i386 SysV ABI-style defaults: 64-bit scalar types commonly align to 4.
                const linuxX86Overrides = {
                    'double': { name: 'double', size: 8, alignment: 4, category: 'primitive' as const },
                    'long long': { name: 'long long', size: 8, alignment: 4, category: 'primitive' as const },
                    'unsigned long long': { name: 'unsigned long long', size: 8, alignment: 4, category: 'primitive' as const },
                    'int64_t': { name: 'int64_t', size: 8, alignment: 4, category: 'primitive' as const },
                    'uint64_t': { name: 'uint64_t', size: 8, alignment: 4, category: 'primitive' as const },
                    'float64': { name: 'float64', size: 8, alignment: 4, category: 'primitive' as const },
                    'f64': { name: 'f64', size: 8, alignment: 4, category: 'primitive' as const },
                    'long double': { name: 'long double', size: 12, alignment: 4, category: 'primitive' as const },
                };
                dataTypes = { ...(dataTypes ?? {}), ...linuxX86Overrides };
            } else if (osType === 'windows') {
                // Win32/MSVC-style defaults: keep 64-bit scalar alignment at 8.
                const windowsX86Overrides = {
                    'double': { name: 'double', size: 8, alignment: 8, category: 'primitive' as const },
                    'long long': { name: 'long long', size: 8, alignment: 8, category: 'primitive' as const },
                    'unsigned long long': { name: 'unsigned long long', size: 8, alignment: 8, category: 'primitive' as const },
                    'int64_t': { name: 'int64_t', size: 8, alignment: 8, category: 'primitive' as const },
                    'uint64_t': { name: 'uint64_t', size: 8, alignment: 8, category: 'primitive' as const },
                    'float64': { name: 'float64', size: 8, alignment: 8, category: 'primitive' as const },
                    'f64': { name: 'f64', size: 8, alignment: 8, category: 'primitive' as const },
                    'long double': { name: 'long double', size: 8, alignment: 8, category: 'primitive' as const },
                };
                dataTypes = { ...(dataTypes ?? {}), ...windowsX86Overrides };
            }
            break;
        case 'intel-x64-amd':
            defaultAlignment = 8;
            maxAlignment = 16;
            packingRules = { structAlignment: 'max', paddingAlignment: true };
            if (osType === 'windows') {
                dataTypes = {
                    ...(dataTypes ?? {}),
                    'long double': { name: 'long double', size: 8, alignment: 8, category: 'primitive' as const },
                };
            } else if (osType === 'linux') {
                dataTypes = {
                    ...(dataTypes ?? {}),
                    'long double': { name: 'long double', size: 16, alignment: 16, category: 'primitive' as const },
                };
            }
            break;
        case 'arm32':
        case 'riscv32':
            defaultAlignment = 4;
            maxAlignment = 8;
            packingRules = { structAlignment: 'max', paddingAlignment: true };
            break;
        case 'arm64':
        case 'riscv64':
            defaultAlignment = 8;
            maxAlignment = 16;
            packingRules = { structAlignment: 'max', paddingAlignment: true };
            break;
        case 'microchip-8bit':
            // AVR (avr-gcc, which XC8 for AVR is built on) aligns every type to 1.
            defaultAlignment = 1;
            maxAlignment = 1;
            packingRules = { structAlignment: 'default', paddingAlignment: false };
            break;
        case 'microchip-16bit':
            defaultAlignment = 1;
            maxAlignment = 4;
            packingRules = { structAlignment: 'default', paddingAlignment: false };
            break;
        case 'microchip-32bit':
            defaultAlignment = 4;
            maxAlignment = 8;
            packingRules = { structAlignment: 'max', paddingAlignment: true };
            break;
        case '8051-8bit':
            defaultAlignment = 1;
            maxAlignment = 1;
            packingRules = { structAlignment: 'default', paddingAlignment: false };
            break;
        default:
            break;
    }

    return {
        ...baseArchitecture,
        dataTypes,
        pointerSize,
        defaultAlignment,
        maxAlignment,
        packingRules,
        ...bitfieldAndEnumRules(dataModel, targetArchitecture, osType),
    };
}

/**
 * How the target's compiler lays out bit-fields and plain enums. Every combination here is checked
 * against that compiler in tests/bitfield-compiler.test.ts, except those `bitfieldsVerified`
 * reports as not.
 */
function bitfieldAndEnumRules(
    dataModel: DataModel,
    targetArchitecture: TargetArchitecture,
    osType: OSType,
): Pick<ResolvedArchitecture, 'bitfieldLayout' | 'bitfieldTypeMatters' | 'alignUnnamedBitfields' | 'shortEnums'> {
    // MSVC, and MinGW with its default -mms-bitfields.
    if (osType === 'windows') return { bitfieldLayout: 'ms' };
    if (dataModel === 'SDCC') return { bitfieldLayout: 'sdcc' };
    const arm = targetArchitecture === 'arm32' || targetArchitecture === 'arm64';
    return {
        bitfieldLayout: 'gcc',
        // avr-gcc does not define PCC_BITFIELD_TYPE_MATTERS.
        bitfieldTypeMatters: targetArchitecture !== 'microchip-8bit',
        // GCC's ARM and AArch64 ports return true from align_anon_bitfield.
        alignUnnamedBitfields: arm,
        // arm-none-eabi GCC defaults to -fshort-enums; Linux (gnueabihf, AArch64) does not.
        shortEnums: targetArchitecture === 'arm32' && osType === 'none',
    };
}

/**
 * Whether this platform's bit-field layout has been checked against its compiler, and if not,
 * which compiler it would need. The checked ones are the targets of tests/bitfield-compiler.test.ts;
 * XC16 and Keil C51 are proprietary and could not be run.
 */
export function bitfieldVerification(
    dataModel: DataModel,
    targetArchitecture: TargetArchitecture,
    osType: OSType,
): { verified: true } | { verified: false; compiler: string } {
    if (dataModel === 'XC16') return { verified: false, compiler: 'Microchip XC16' };
    if (dataModel === 'C51') return { verified: false, compiler: 'Keil C51' };
    if (targetArchitecture === 'arm64' && osType === 'none') {
        return { verified: false, compiler: 'a bare-metal AArch64 GCC (only aarch64-linux-gnu was checked)' };
    }
    return { verified: true };
}
