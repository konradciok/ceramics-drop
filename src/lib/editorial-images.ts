export type EditorialImage = {
  key: string;
  src: string;
  width: number;
  height: number;
};

export const EDITORIAL_IMAGES = {
  aniaSunlight: { key: 'aniaSunlight', src: '/uploads/3ania.webp', width: 1086, height: 1448 },
  aniaMaker: { key: 'aniaMaker', src: '/uploads/1ania.webp', width: 1366, height: 2048 },
  aniaWorkspace: { key: 'aniaWorkspace', src: '/uploads/2ania.webp', width: 1366, height: 2048 },
  photo01: { key: 'photo01', src: '/uploads/gallery-whatsapp-01.webp', width: 1152, height: 2048 },
  photo02: { key: 'photo02', src: '/uploads/gallery-whatsapp-02.webp', width: 1366, height: 2048 },
  photo03: { key: 'photo03', src: '/uploads/gallery-whatsapp-03.webp', width: 1152, height: 2048 },
  photo04: { key: 'photo04', src: '/uploads/gallery-whatsapp-04.webp', width: 1366, height: 2048 },
  photo05: { key: 'photo05', src: '/uploads/gallery-whatsapp-05.webp', width: 1366, height: 2048 },
  photo06: { key: 'photo06', src: '/uploads/gallery-whatsapp-06.webp', width: 1366, height: 2048 },
  photo07: { key: 'photo07', src: '/uploads/gallery-whatsapp-07.webp', width: 1366, height: 2048 },
  photo08: { key: 'photo08', src: '/uploads/gallery-whatsapp-08.webp', width: 1366, height: 2048 },
  photo09: { key: 'photo09', src: '/uploads/gallery-whatsapp-09.webp', width: 1366, height: 2048 },
  photo10: { key: 'photo10', src: '/uploads/gallery-whatsapp-10.webp', width: 1366, height: 2048 },
  photo11: { key: 'photo11', src: '/uploads/gallery-whatsapp-11.webp', width: 1152, height: 2048 },
  photo12: { key: 'photo12', src: '/uploads/gallery-whatsapp-12.webp', width: 1366, height: 2048 },
  photo13: { key: 'photo13', src: '/uploads/gallery-whatsapp-13.webp', width: 1366, height: 2048 },
  photo14: { key: 'photo14', src: '/uploads/gallery-whatsapp-14.webp', width: 1366, height: 2048 },
  photo15: { key: 'photo15', src: '/uploads/gallery-whatsapp-15.webp', width: 1366, height: 2048 },
} as const satisfies Record<string, EditorialImage>;

export const HOME_EDITORIAL_IMAGE = EDITORIAL_IMAGES.aniaSunlight;
export const HOME_STORY_IMAGE = EDITORIAL_IMAGES.aniaMaker;
export const STUDIO_HEAD_IMAGE = EDITORIAL_IMAGES.aniaWorkspace;
export const STUDIO_STORY_IMAGE = EDITORIAL_IMAGES.aniaMaker;

export const GALLERY_EDITORIAL_IMAGES = [
  EDITORIAL_IMAGES.photo01,
  EDITORIAL_IMAGES.photo02,
  EDITORIAL_IMAGES.photo03,
  EDITORIAL_IMAGES.photo04,
  EDITORIAL_IMAGES.photo05,
  EDITORIAL_IMAGES.photo06,
  EDITORIAL_IMAGES.photo07,
  EDITORIAL_IMAGES.photo08,
  EDITORIAL_IMAGES.photo09,
  EDITORIAL_IMAGES.photo10,
  EDITORIAL_IMAGES.photo11,
  EDITORIAL_IMAGES.photo12,
  EDITORIAL_IMAGES.photo13,
  EDITORIAL_IMAGES.photo14,
  EDITORIAL_IMAGES.photo15,
] as const;

export const DIRECT_EDITORIAL_IMAGES = [
  EDITORIAL_IMAGES.aniaSunlight,
  EDITORIAL_IMAGES.aniaMaker,
  EDITORIAL_IMAGES.aniaWorkspace,
  ...GALLERY_EDITORIAL_IMAGES,
] as const;
