#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const DEFAULT_GUIDELINES_PATH = "docs/brand-guidelines.md";

function extractHexColors(text) {
  const hexPattern = /#[0-9A-Fa-f]{6}\b/g;
  return [...new Set(text.match(hexPattern) || [])];
}

function parseBrandColors(guidelinesPath) {
  const resolvedPath = path.isAbsolute(guidelinesPath)
    ? guidelinesPath
    : path.join(process.cwd(), guidelinesPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const content = fs.readFileSync(resolvedPath, "utf-8");

  const palette = {
    primary: [],
    secondary: [],
    neutral: [],
    semantic: [],
    all: [],
  };
  const sections = [
    { name: "primary", regex: /### Primary[\s\S]*?(?=###|##|$)/i },
    { name: "secondary", regex: /### Secondary[\s\S]*?(?=###|##|$)/i },
    { name: "neutral", regex: /### Neutral[\s\S]*?(?=###|##|$)/i },
    { name: "semantic", regex: /### Semantic[\s\S]*?(?=###|##|$)/i },
  ];

  sections.forEach(({ name, regex }) => {
    const match = content.match(regex);
    if (match) {
      const colors = extractHexColors(match[0]);
      palette[name] = colors;
      palette.all.push(...colors);
    }
  });
  palette.all = [...new Set(palette.all)];

  return palette;
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
      .toUpperCase()
  );
}

function colorDistance(color1, color2) {
  const rgb1 = typeof color1 === "string" ? hexToRgb(color1) : color1;
  const rgb2 = typeof color2 === "string" ? hexToRgb(color2) : color2;

  if (!rgb1 || !rgb2) return Infinity;

  return Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
      Math.pow(rgb1.g - rgb2.g, 2) +
      Math.pow(rgb1.b - rgb2.b, 2)
  );
}

function findNearestBrandColor(color, brandColors) {
  let nearest = null;
  let minDistance = Infinity;

  brandColors.forEach((brandColor) => {
    const distance = colorDistance(color, brandColor);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = brandColor;
    }
  });

  return { color: nearest, distance: minDistance };
}

function calculateCompliance(extractedColors, brandColors, threshold = 50) {
  if (!extractedColors || extractedColors.length === 0) return 100;
  if (!brandColors || brandColors.length === 0) return 0;

  let matchCount = 0;

  extractedColors.forEach((color) => {
    const nearest = findNearestBrandColor(color, brandColors);
    if (nearest.distance <= threshold) {
      matchCount++;
    }
  });

  return Math.round((matchCount / extractedColors.length) * 100);
}

function generateImageMagickCommand(imagePath, numColors = 10) {
  return `magick "${imagePath}" -colors ${numColors} -depth 8 -format "%c" histogram:info:`;
}

function parseImageMagickOutput(output) {
  const colors = [];
  const lines = output.trim().split("\n");

  lines.forEach((line) => {
    const hexMatch = line.match(/#([0-9A-Fa-f]{6})/);
    const countMatch = line.match(/^\s*(\d+):/);

    if (hexMatch) {
      colors.push({
        hex: "#" + hexMatch[1].toUpperCase(),
        count: countMatch ? parseInt(countMatch[1]) : 0,
      });
    }
  });
  colors.sort((a, b) => b.count - a.count);

  return colors;
}

function displayPalette(palette) {
  console.log("\n" + "=".repeat(50));
  console.log("BRAND COLOR PALETTE");
  console.log("=".repeat(50));

  if (palette.primary.length > 0) {
    console.log("\nPrimary Colors:");
    palette.primary.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.secondary.length > 0) {
    console.log("\nSecondary Colors:");
    palette.secondary.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.neutral.length > 0) {
    console.log("\nNeutral Colors:");
    palette.neutral.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.semantic.length > 0) {
    console.log("\nSemantic Colors:");
    palette.semantic.forEach((c) => console.log(`  ${c}`));
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Total: ${palette.all.length} colors in brand palette`);
  console.log("=".repeat(50) + "\n");
}

function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const showPalette = args.includes("--palette");
  const brandFileIdx = args.indexOf("--brand-file");
  const brandFile =
    brandFileIdx !== -1 ? args[brandFileIdx + 1] : DEFAULT_GUIDELINES_PATH;
  const brandFileValue = brandFileIdx !== -1 ? args[brandFileIdx + 1] : null;
  const imagePath = args.find(
    (a) => !a.startsWith("--") && a !== brandFileValue
  );
  const brandPalette = parseBrandColors(brandFile);

  if (!brandPalette) {
    console.error(`Brand guidelines not found at: ${brandFile}`);
    console.error(`Create brand guidelines or specify path with --brand-file`);
    process.exit(1);
  }
  if (showPalette || !imagePath) {
    if (jsonOutput) {
      console.log(JSON.stringify(brandPalette, null, 2));
    } else {
      displayPalette(brandPalette);

      if (!imagePath) {
        console.log("To extract colors from an image:");
        console.log("  node extract-colors.cjs <image-path>");
        console.log("\nOr use ImageMagick directly:");
        console.log('  magick image.png -colors 10 -depth 8 -format "%c" histogram:info:');
      }
    }
    return;
  }
  const resolvedPath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Image not found: ${resolvedPath}`);
    process.exit(1);
  }
  const result = {
    image: resolvedPath,
    brandPalette: brandPalette,
    extractionCommand: generateImageMagickCommand(resolvedPath),
    instructions: [
      "1. Run the ImageMagick command to extract colors:",
      `   ${generateImageMagickCommand(resolvedPath)}`,
      "",
      "2. Or use the ai-multimodal skill:",
      `   python .claude/skills/ai-multimodal/scripts/gemini_batch_process.py \\`,
      `     --files "${resolvedPath}" \\`,
      `     --task analyze \\`,
      `     --prompt "Extract the 10 most dominant colors as hex values"`,
      "",
      "3. Then compare extracted colors against brand palette",
    ],
    complianceCheck: {
      threshold: 50,
      description:
        "Colors within distance 50 (RGB space) are considered brand-compliant",
      brandColors: brandPalette.all,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n" + "=".repeat(60));
    console.log("COLOR EXTRACTION HELPER");
    console.log("=".repeat(60));
    console.log(`\nImage: ${result.image}`);
    console.log(`\nBrand Colors: ${brandPalette.all.length} colors loaded`);
    console.log("\nTo extract colors from this image:\n");
    result.instructions.forEach((line) => console.log(line));
    console.log("\n" + "=".repeat(60));
    console.log("\nBrand Palette Reference:");
    console.log(`  Primary: ${brandPalette.primary.join(", ") || "none"}`);
    console.log(`  Secondary: ${brandPalette.secondary.join(", ") || "none"}`);
    console.log(`  Neutral: ${brandPalette.neutral.join(", ") || "none"}`);
    console.log("=".repeat(60) + "\n");
  }
}
module.exports = {
  parseBrandColors,
  hexToRgb,
  rgbToHex,
  colorDistance,
  findNearestBrandColor,
  calculateCompliance,
  parseImageMagickOutput,
};
if (require.main === module) {
  main();
}
