import type {
  AgentCallback,
  CampaignList,
  Channel,
  Coverage,
  Customer,
  Inquiry,
  Policy,
  Product,
  RenewalStatus,
  SyncStatus,
} from "./types";

const now = () => new Date().toISOString();
const isoDay = (offset: number) => {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

const fullCoverage: Coverage = {
  thirdPartyProperty: true,
  thirdPartyInjury: true,
  ownVehicleCollision: true,
  vehicleTheft: true,
  fire: true,
  flood: true,
  personalAccident: true,
  medicalExpense: true,
  driverBail: true,
};

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return { ...fullCoverage, ...overrides };
}

const productSpecs = [
  [
    "MFEC Motor One",
    "motor-one",
    "CAR",
    "1",
    15900,
    "คุ้มครองรอบด้านสำหรับรถที่คุณรัก",
    true,
    coverage(),
    ["ซ่อมห้างหรืออู่คู่สัญญา", "รถชน รถหาย ไฟไหม้ น้ำท่วม"],
  ],
  [
    "Motor Flex 2+",
    "motor-flex-2-plus",
    "CAR",
    "2+",
    8900,
    "คุ้มครองรถชนรถ พร้อมความสบายใจเรื่องรถหาย",
    true,
    coverage({ flood: false }),
    ["รถชนรถ", "รถหายและไฟไหม้"],
  ],
  [
    "Motor Secure 2",
    "motor-secure-2",
    "CAR",
    "2",
    6900,
    "คุ้มครองบุคคลภายนอกพร้อมรถหายและไฟไหม้",
    false,
    coverage({ ownVehicleCollision: false, flood: false }),
    ["รถหายและไฟไหม้", "คุ้มครองคู่กรณี"],
  ],
  [
    "Motor Smart 3+",
    "motor-smart-3-plus",
    "CAR",
    "3+",
    5900,
    "เลือกความคุ้มครองที่พอดีกับรถและงบ",
    true,
    coverage({ vehicleTheft: false, fire: false, flood: false }),
    ["รถชนรถ", "เบี้ยคุ้มค่า"],
  ],
  [
    "Motor Essential 3",
    "motor-essential-3",
    "CAR",
    "3",
    3200,
    "ความคุ้มครองพื้นฐานเพื่อทุกการเดินทาง",
    false,
    coverage({
      ownVehicleCollision: false,
      vehicleTheft: false,
      fire: false,
      flood: false,
    }),
    ["คุ้มครองคู่กรณี", "เริ่มต้นง่าย"],
  ],
  [
    "Motorcycle Protect+",
    "motorcycle-protect-plus",
    "MOTORCYCLE",
    "2+",
    4250,
    "สำหรับมอเตอร์ไซค์คู่ใจในทุกวัน",
    true,
    coverage({ flood: false }),
    ["รถชนรถ", "รถหายและไฟไหม้"],
  ],
  [
    "Motorcycle Delivery Protect",
    "motorcycle-delivery-protect",
    "MOTORCYCLE",
    "3+",
    3800,
    "ออกแบบเพื่อการเดินทางและงานส่งสินค้า",
    false,
    coverage({ vehicleTheft: false, fire: false, flood: false }),
    ["รองรับการใช้งานส่งของ", "คุ้มครองอุบัติเหตุ"],
  ],
  [
    "Motor Gap Protection",
    "motor-gap-protection",
    "ADDON",
    "ADDON",
    1850,
    "เพิ่มความมั่นใจให้ภาระทางการเงินของรถ",
    false,
    coverage({
      ownVehicleCollision: false,
      vehicleTheft: false,
      fire: false,
      flood: false,
    }),
    ["ความคุ้มครองเสริม", "เหมาะกับรถผ่อน"],
  ],
  [
    "Accident Usage Protection",
    "accident-usage-protection",
    "ADDON",
    "ADDON",
    1250,
    "เสริมการดูแลระหว่างใช้งานรถ",
    false,
    coverage({
      ownVehicleCollision: false,
      vehicleTheft: false,
      fire: false,
      flood: false,
    }),
    ["อุบัติเหตุส่วนบุคคล", "ค่ารักษาพยาบาล"],
  ],
  [
    "EV Drive Care",
    "ev-drive-care",
    "CAR",
    "1",
    19900,
    "ดูแลรถไฟฟ้าและทุกเส้นทางที่คุณเลือก",
    true,
    coverage(),
    ["รถไฟฟ้า", "น้ำท่วมและไฟไหม้"],
  ],
] as const;

export function seedProducts(): Product[] {
  return productSpecs.map(
    (
      [
        name,
        slug,
        vehicleType,
        insuranceClass,
        premium,
        description,
        featured,
        cover,
        features,
      ],
      index,
    ) => ({
      productId: `PROD${String(index + 1).padStart(5, "0")}`,
      productCode: `MFEC-${String(index + 1).padStart(3, "0")}`,
      slug,
      productName: name,
      productType: vehicleType === "ADDON" ? "SUPPLEMENT" : "MOTOR",
      vehicleType,
      insuranceClass,
      shortDescription: description,
      description: `${description} ข้อมูลนี้ใช้เพื่อสาธิตเท่านั้น กรุณาตรวจสอบรายละเอียดจริงก่อนทำประกันภัย`,
      insurerName: "MFEC Demo Insurance",
      startingPremium: premium,
      coverage: cover,
      coverageLimits: {
        thirdPartyProperty: "สูงสุด 1,000,000 บาท",
        thirdPartyInjury: "สูงสุด 1,000,000 บาท/คน",
        ownVehicleCollision: "ตามทุนประกัน",
      },
      features: [...features],
      terms: [
        "ผลิตภัณฑ์และเบี้ยประกันเป็นข้อมูลสาธิต",
        "ความคุ้มครองขึ้นอยู่กับเงื่อนไขของกรมธรรม์จริง",
      ],
      eligibleVehicleTypes:
        vehicleType === "MOTORCYCLE"
          ? ["รถจักรยานยนต์"]
          : vehicleType === "ADDON"
            ? ["รถยนต์", "รถจักรยานยนต์"]
            : ["รถยนต์ส่วนบุคคล"],
      minVehicleAge: 0,
      maxVehicleAge: insuranceClass === "1" ? 12 : 20,
      active: true,
      featured,
      displayOrder: index + 1,
      createdAt: now(),
      updatedAt: now(),
    }),
  );
}

const firstNames = [
  "สมชาย",
  "มณี",
  "อนันต์",
  "กานดา",
  "วิทยา",
  "พิมพ์ชนก",
  "ธนวัฒน์",
  "สุภาวดี",
  "ปกรณ์",
  "นลิน",
];
const provinces = [
  "กรุงเทพมหานคร",
  "นนทบุรี",
  "เชียงใหม่",
  "ชลบุรี",
  "ขอนแก่น",
  "ภูเก็ต",
];
const channels: Channel[] = ["VOICE", "DIGITAL", "LINE", "SMS", "EMAIL"];

export function seedCustomers(): Customer[] {
  return Array.from({ length: 30 }, (_, index) => ({
    customerId: `CUST${String(index + 1).padStart(5, "0")}`,
    firstName: index === 0 ? "สมชาย" : firstNames[index % firstNames.length],
    lastName:
      index === 0 ? "ตัวอย่าง" : `สาธิต${String(index + 1).padStart(2, "0")}`,
    phone:
      index === 0
        ? "+66812345678"
        : `+6680000${String(index + 1).padStart(4, "0")}`,
    email: `demo${index + 1}@example.invalid`,
    preferredChannel: channels[index % channels.length],
    province: provinces[index % provinces.length],
    dnc: index > 0 && index % 11 === 0,
    createdAt: now(),
    updatedAt: now(),
  }));
}

const vehicles = [
  ["Toyota", "Yaris"],
  ["Honda", "City"],
  ["Isuzu", "D-Max"],
  ["Mazda", "Mazda 2"],
  ["Ford", "Ranger"],
  ["Nissan", "Almera"],
  ["BYD", "Dolphin"],
  ["MG", "MG4"],
  ["Mercedes-Benz", "C-Class"],
  ["BMW", "3 Series"],
  ["Yamaha", "NMAX"],
  ["Kawasaki", "Ninja 400"],
] as const;
const renewalStatuses: RenewalStatus[] = [
  "CONTACT_PENDING",
  "INTERESTED",
  "CALLBACK_REQUESTED",
  "NOT_INTERESTED",
  "RENEWED",
  "CONTACTED",
  "NOT_STARTED",
];
const expiryOffsets = [-15, 3, 11, 24, 45, 72, 87, 130];

export function emptyGenesys(): Policy["genesys"] {
  return {
    contactListId: "",
    contactId: "",
    syncStatus: "NOT_SYNCED",
    lastSyncAt: "",
    lastSyncError: null,
    lastPayloadHash: "",
    lastSyncedBy: "",
  };
}

export function seedPolicies(): Policy[] {
  const products = seedProducts();
  return Array.from({ length: 40 }, (_, index) => {
    const first = index === 0;
    const product = first ? products[5] : products[index % products.length];
    const [brand, model] = first
      ? ["Honda", "PCX 160"]
      : vehicles[index % vehicles.length];
    const syncStatus: SyncStatus =
      index % 13 === 0 && !first
        ? "FAILED"
        : index % 9 === 0 && !first
          ? "SYNCED"
          : "NOT_SYNCED";
    const expiryDate = first
      ? "2026-11-14"
      : isoDay(expiryOffsets[index % expiryOffsets.length]);
    return {
      policyId: `POL${String(index + 1).padStart(5, "0")}`,
      policyNumber: first
        ? "MFEC-MC-2026-00001"
        : `MFEC-${product.vehicleType === "MOTORCYCLE" ? "MC" : "CAR"}-2026-${String(index + 1).padStart(5, "0")}`,
      customerId: `CUST${String((index % 30) + 1).padStart(5, "0")}`,
      productId: product.productId,
      purchaseDate: first ? "2026-01-15" : isoDay(-290 + index),
      effectiveDate: first ? "2025-11-15" : isoDay(-365 + index),
      expiryDate,
      premium: first ? 4250 : product.startingPremium + (index % 4) * 650,
      sumInsured: first
        ? 100000
        : product.vehicleType === "MOTORCYCLE"
          ? 100000
          : 500000,
      insurerName: "MFEC Demo Insurance",
      vehicle: {
        vehicleType: first ? "MOTORCYCLE" : product.vehicleType,
        brand,
        model,
        year: first ? 2024 : 2018 + (index % 8),
        licensePlate: first
          ? "1กข1234"
          : `กท${String(index + 1000).padStart(4, "0")}`,
        province: provinces[index % provinces.length],
      },
      coverageSnapshot: { ...product.coverage },
      renewalStatus: first
        ? "CONTACT_PENDING"
        : renewalStatuses[index % renewalStatuses.length],
      preferredChannel: first ? "VOICE" : channels[index % channels.length],
      digitalSent: !first && index % 5 === 0,
      voiceCalled: !first && index % 4 === 0,
      customerIntent: first
        ? "UNKNOWN"
        : index % 7 === 1
          ? "INTERESTED"
          : "UNKNOWN",
      callbackDateTime:
        index % 7 === 2
          ? new Date(Date.now() + 86400000 * 2).toISOString()
          : null,
      genesys: {
        ...emptyGenesys(),
        syncStatus,
        contactId: syncStatus === "SYNCED" ? `demo-contact-${index}` : "",
        contactListId: syncStatus === "SYNCED" ? "demo-list" : "",
        lastSyncError: syncStatus === "FAILED" ? "Demo sync failure" : null,
      },
      createdAt: now(),
      updatedAt: now(),
    };
  });
}

export function seedInquiries(): Inquiry[] {
  return Array.from({ length: 5 }, (_, index) => ({
    inquiryId: `INQ${String(index + 1).padStart(5, "0")}`,
    firstName: firstNames[index],
    lastName: `ผู้สนใจ${index + 1}`,
    phone: `+6680999${String(index + 1).padStart(4, "0")}`,
    productId: `PROD${String(index + 1).padStart(5, "0")}`,
    preferredChannel: channels[index % channels.length],
    preferredContactTime: "ช่วงเวลาทำการ",
    consent: true,
    status: index < 2 ? "NEW" : index === 2 ? "CONTACTED" : "CLOSED",
    createdAt: now(),
    updatedAt: now(),
  }));
}

export function seedAgentCallbacks(): AgentCallback[] {
  return seedPolicies()
    .filter(
      (policy) =>
        policy.callbackDateTime &&
        policy.renewalStatus === "CALLBACK_REQUESTED",
    )
    .map((policy, index) => ({
      callbackId: `CALL${String(index + 1).padStart(5, "0")}`,
      customerId: policy.customerId,
      policyId: policy.policyId,
      scheduledAt: policy.callbackDateTime!,
      status: "SCHEDULED",
      priority: index === 0 ? "HIGH" : "NORMAL",
      intent: "CALLBACK_REQUEST",
      assignedAgent: "",
      agentName: "",
      notes: "Customer requested a renewal callback.",
      outcomeNotes: "",
      completedAt: "",
      createdBy: "system",
      updatedBy: "system",
      createdAt: now(),
      updatedAt: now(),
    }));
}

const campaignSpecs = [
  ["Motor Renewal - Next 30 Days", { daysFrom: 0, daysTo: 30 }],
  ["Motor Renewal - Next 60 Days", { daysFrom: 0, daysTo: 60 }],
  [
    "Motorcycle Renewal",
    { vehicleType: "MOTORCYCLE", daysFrom: 0, daysTo: 90 },
  ],
  [
    "Voice Renewal Campaign",
    { preferredChannel: "VOICE", daysFrom: 0, daysTo: 90 },
  ],
  [
    "Digital First Renewal",
    { preferredChannel: "DIGITAL", daysFrom: 0, daysTo: 90 },
  ],
  ["Callback Follow-up", { renewalStatus: "CALLBACK_REQUESTED" }],
] as const;

export function seedCampaignLists(): CampaignList[] {
  return campaignSpecs.map(([name, filters], index) => ({
    campaignListId: `CAMP${String(index + 1).padStart(5, "0")}`,
    name,
    description: "รายการสาธิตสำหรับจัดการติดต่อต่ออายุ",
    filters: { ...filters, excludeDnc: true },
    createdAt: now(),
    updatedAt: now(),
    recordCount: 0,
    lastExportedAt: "",
    lastGenesysSyncAt: "",
  }));
}
