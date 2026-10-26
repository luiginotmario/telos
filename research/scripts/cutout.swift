// Lifts the figure out of each hominin reconstruction with Apple's on-device subject
// segmentation (Vision), crops tight to head-and-feet, and writes a transparent PNG.
// The crop matters: the site scales each figure so its pixel height equals its true height.
//
//   swift research/scripts/cutout.swift <in.png> <out.png> [<in.png> <out.png> ...]

import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

enum CutoutError: Error, CustomStringConvertible {
  case unreadable(String), noSubject(String), unwritable(String)
  var description: String {
    switch self {
    case .unreadable(let p): "cannot read \(p)"
    case .noSubject(let p): "no foreground subject in \(p)"
    case .unwritable(let p): "cannot write \(p)"
    }
  }
}

let context = CIContext()

func cutout(_ input: URL, to output: URL) throws {
  guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { throw CutoutError.unreadable(input.path) }

  let request = VNGenerateForegroundInstanceMaskRequest()
  let handler = VNImageRequestHandler(cgImage: image)
  try handler.perform([request])
  guard let result = request.results?.first, !result.allInstances.isEmpty
  else { throw CutoutError.noSubject(input.path) }

  // every instance: the figure plus anything attached to it (hair, loincloth)
  let buffer = try result.generateMaskedImage(
    ofInstances: result.allInstances, from: handler, croppedToInstancesExtent: true)
  let masked = CIImage(cvPixelBuffer: buffer)
  guard let out = context.createCGImage(masked, from: masked.extent)
  else { throw CutoutError.unwritable(output.path) }

  guard let dest = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { throw CutoutError.unwritable(output.path) }
  CGImageDestinationAddImage(dest, out, nil)
  guard CGImageDestinationFinalize(dest) else { throw CutoutError.unwritable(output.path) }
  print("\(output.lastPathComponent): \(out.width)×\(out.height)")
}

let args = Array(CommandLine.arguments.dropFirst())
precondition(args.count >= 2 && args.count.isMultiple(of: 2), "usage: cutout <in> <out> [<in> <out> ...]")
var failed = false
for i in stride(from: 0, to: args.count, by: 2) {
  do { try cutout(URL(fileURLWithPath: args[i]), to: URL(fileURLWithPath: args[i + 1])) }
  catch { print("error: \(error)"); failed = true }
}
exit(failed ? 1 : 0)
