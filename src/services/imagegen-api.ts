import { invoke } from "@tauri-apps/api/core";

export interface ImageGeneration {
  id: string;
  prompt: string;
  imageData: string;
  sizeLabel: string | null;
  referenceImagesJson?: string | null;
  createdAt: number;
}

export function saveImageGeneration(
  id: string,
  prompt: string,
  imageData: string,
  sizeLabel?: string,
  referenceImages?: string[],
): Promise<ImageGeneration> {
  return invoke<ImageGeneration>("save_image_generation", {
    request: {
      id,
      prompt,
      imageData,
      sizeLabel,
      referenceImagesJson: referenceImages ? JSON.stringify(referenceImages) : null,
    },
  });
}

export function listImageGenerations(): Promise<ImageGeneration[]> {
  return invoke<ImageGeneration[]>("list_image_generations");
}

export function deleteImageGeneration(id: string): Promise<void> {
  return invoke("delete_image_generation", { id });
}

export function clearImageGenerations(): Promise<void> {
  return invoke("clear_image_generations");
}
