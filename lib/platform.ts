/** Built with the desktop server so the initial HTML and the renderer use the same labels. */
export const WINDOWS = process.env.NEXT_PUBLIC_BOPS_PLATFORM === "win32";
export const DESKTOP_NAME = WINDOWS ? "PC" : "Mac";
export const THIS_COMPUTER = `This ${DESKTOP_NAME}`;
export const YOUR_COMPUTER = `Your ${DESKTOP_NAME}`;
export const FILE_MANAGER = WINDOWS ? "File Explorer" : "Finder";
export const SYSTEM_SETTINGS = WINDOWS ? "Windows Settings" : "System Settings";
export const SHORTCUT_MODIFIER = WINDOWS ? "Ctrl" : "⌘";
export const SECRET_STORAGE = WINDOWS ? "Windows encrypted storage" : "your Mac's Keychain";
