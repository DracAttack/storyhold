import { useState, useRef, useCallback } from "react";
import { UploadCloud, X, ImageIcon, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { uploadFile, useQueuePosts } from "@/hooks/api";
import { toast } from "sonner";

interface FilePreview {
  id: string;
  file: File;
  previewUrl: string;
  caption: string;
}

export function UploadArea() {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<FilePreview[]>([]);
  const [globalCaption, setGlobalCaption] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const queuePostsMutation = useQueuePosts();

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const processFiles = (files: File[]) => {
    const validFiles = files.filter(f => f.type.startsWith('image/'));
    const newPreviews = validFiles.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      previewUrl: URL.createObjectURL(file),
      caption: globalCaption
    }));
    setPreviews(prev => [...prev, ...newPreviews]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(Array.from(e.target.files));
    }
  };

  const handleRemove = (id: string) => {
    setPreviews(prev => {
      const item = prev.find(p => p.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter(p => p.id !== id);
    });
  };

  const updateCaption = (id: string, caption: string) => {
    setPreviews(prev => prev.map(p => p.id === id ? { ...p, caption } : p));
  };

  const applyGlobalCaption = () => {
    setPreviews(prev => prev.map(p => ({ ...p, caption: globalCaption })));
  };

  const handleAddToQueue = async () => {
    if (previews.length === 0) return;
    setIsUploading(true);
    try {
      const items = [];
      for (const p of previews) {
        const result = await uploadFile(p.file);
        items.push({
          imageUrl: result.imageUrl,
          imageStorageKey: result.objectPath,
          originalFilename: result.originalFilename,
          caption: p.caption
        });
      }
      await queuePostsMutation.mutateAsync({ items });
      toast.success(`Successfully added ${items.length} post(s) to the queue.`);
      setPreviews([]);
      setGlobalCaption("");
    } catch (err: any) {
      toast.error(err.message || "Failed to add posts to the queue.", { duration: 10000 });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label htmlFor="global-caption">Global Caption (Optional)</Label>
        <div className="flex gap-2">
          <Input 
            id="global-caption" 
            placeholder="Use this caption for all..." 
            value={globalCaption}
            onChange={(e) => setGlobalCaption(e.target.value)}
            className="flex-1"
            data-testid="input-global-caption"
          />
          <Button variant="secondary" onClick={applyGlobalCaption} data-testid="btn-apply-global-caption">Apply to All</Button>
        </div>
      </div>

      <div 
        className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-colors text-center cursor-pointer min-h-[200px] ${
          isDragging ? "border-primary bg-primary/10" : "border-border hover:border-primary/50 hover:bg-card"
        }`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        data-testid="upload-area"
      >
        <input 
          type="file" 
          ref={fileInputRef} 
          className="hidden" 
          multiple 
          accept=".png,.jpg,.jpeg,.webp" 
          onChange={handleFileSelect} 
        />
        <UploadCloud className="w-10 h-10 text-muted-foreground mb-4" />
        <p className="text-sm font-medium text-foreground">Click or drag images here to upload</p>
        <p className="text-xs text-muted-foreground mt-1">PNG, JPG, WEBP supported</p>
      </div>

      {previews.length > 0 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-muted-foreground">Ready to queue ({previews.length})</h3>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  previews.forEach((p) => URL.revokeObjectURL(p.previewUrl));
                  setPreviews([]);
                }}
                disabled={isUploading}
                className="text-muted-foreground hover:text-destructive"
                data-testid="btn-clear-all"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Clear All
              </Button>
              <Button onClick={handleAddToQueue} disabled={isUploading} className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold" data-testid="btn-add-queue">
                {isUploading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Add to Queue
              </Button>
            </div>
          </div>
          
          <div className="grid gap-4">
            {previews.map((p) => (
              <Card key={p.id} className="overflow-hidden bg-card border-border shadow-sm">
                <CardContent className="p-0 flex flex-col sm:flex-row">
                  <div className="relative w-full sm:w-40 sm:min-w-40 h-40 bg-muted flex-shrink-0">
                    <img src={p.previewUrl} alt="Preview" className="w-full h-full object-cover" />
                    <Button 
                      variant="destructive" 
                      size="icon" 
                      className="absolute top-2 right-2 h-6 w-6 rounded-full opacity-80 hover:opacity-100" 
                      onClick={(e) => { e.stopPropagation(); handleRemove(p.id); }}
                      data-testid={`btn-remove-${p.id}`}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="flex-1 p-4 flex flex-col gap-2">
                    <Textarea 
                      placeholder="Write a caption..." 
                      className="resize-none flex-1 min-h-[100px] border-input focus-visible:ring-primary bg-background"
                      value={p.caption}
                      onChange={(e) => updateCaption(p.id, e.target.value)}
                      data-testid={`input-caption-${p.id}`}
                    />
                    <div className="flex items-center justify-between">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(p.id)}
                        disabled={isUploading}
                        className="text-xs h-7 text-muted-foreground hover:text-destructive"
                        data-testid={`btn-remove-labeled-${p.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remove
                      </Button>
                      <div className="text-xs text-muted-foreground">
                        {p.caption.length} characters
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
