export type EditorialImage = {
  key: string;
  src: string;
  width: number;
  height: number;
};

export const EDITORIAL_IMAGES = {
  aniaMaker: { key: 'aniaMaker', src: '/uploads/1ania.webp', width: 800, height: 1200 },
  aniaWorkspace: { key: 'aniaWorkspace', src: '/uploads/2ania.webp', width: 1366, height: 2048 },
  pdpAuthor: { key: 'pdpAuthor', src: '/uploads/pdp-author.webp', width: 933, height: 1400 },
  homeEditorialDesktop: {
    key: 'homeEditorialDesktop',
    src: '/uploads/home-editorial.webp',
    width: 1920,
    height: 1080,
  },
  homeEditorialMobile: {
    key: 'homeEditorialMobile',
    src: '/uploads/home-editorial-mobile.webp',
    width: 1080,
    height: 1350,
  },
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

export const HOME_EDITORIAL_DESKTOP_IMAGE = EDITORIAL_IMAGES.homeEditorialDesktop;
export const HOME_EDITORIAL_MOBILE_IMAGE = EDITORIAL_IMAGES.homeEditorialMobile;
/** Landscape stand-in for consumers that need a single URL (showroom JSON-LD og:image). */
export const HOME_EDITORIAL_IMAGE = HOME_EDITORIAL_DESKTOP_IMAGE;
export const HOME_STORY_IMAGE = EDITORIAL_IMAGES.aniaMaker;
export const STUDIO_HEAD_IMAGE = EDITORIAL_IMAGES.aniaWorkspace;
export const STUDIO_STORY_IMAGE = EDITORIAL_IMAGES.aniaMaker;
// Print PDP "About the Artist" band — portrait of Anna in the studio.
export const PRINT_PDP_ARTIST_IMAGE = EDITORIAL_IMAGES.pdpAuthor;

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
  EDITORIAL_IMAGES.homeEditorialDesktop,
  EDITORIAL_IMAGES.homeEditorialMobile,
  EDITORIAL_IMAGES.aniaMaker,
  EDITORIAL_IMAGES.aniaWorkspace,
  EDITORIAL_IMAGES.pdpAuthor,
  ...GALLERY_EDITORIAL_IMAGES,
] as const;
