import { useState } from "react";
import { Header } from "@/components/layout/Header";
import { useSettings, useUpdateSettings, usePostingSlots, useCreatePostingSlot, useDeletePostingSlot, useUpdatePostingSlot, useTestZernio } from "@/hooks/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, Clock, Loader2, CheckCircle2, XCircle, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Skeleton } from "@/components/ui/skeleton";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIMEZONES = [
  "America/Phoenix",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Denver",
  "UTC"
];

export default function SettingsPage() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const updateSettings = useUpdateSettings();
  
  const { data: slots, isLoading: slotsLoading } = usePostingSlots();
  const createSlot = useCreatePostingSlot();
  const updateSlot = useUpdatePostingSlot();
  const deleteSlot = useDeletePostingSlot();

  const testZernio = useTestZernio();

  const [destinationId, setDestinationId] = useState("");
  const [destIdSaved, setDestIdSaved] = useState(false);
  
  const [newTime, setNewTime] = useState("09:00");
  const [newDays, setNewDays] = useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri default

  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [editTime, setEditTime] = useState("09:00");
  const [editDays, setEditDays] = useState<number[]>([]);

  // Sync destination id once loaded
  if (settings && !destinationId && !destIdSaved) {
    setDestinationId(settings.destinationId || "");
    setDestIdSaved(true);
  }

  const handleTimezoneChange = async (val: string) => {
    try {
      await updateSettings.mutateAsync({ timezone: val });
      toast.success("Timezone updated");
    } catch (err: any) {
      toast.error(`Failed to update timezone: ${err.message}`);
    }
  };

  const handleDestinationSave = async () => {
    try {
      await updateSettings.mutateAsync({ destinationId });
      toast.success("Facebook Destination ID saved");
    } catch (err: any) {
      toast.error(`Failed to save Destination ID: ${err.message}`);
    }
  };

  const handleTestConnection = async () => {
    try {
      const res = await testZernio.mutateAsync();
      if (res.connected) {
        toast.success(res.message || "Connection successful!");
      } else {
        toast.error(res.message || "Connection failed.");
      }
    } catch (err: any) {
      toast.error(`Test failed: ${err.message}`);
    }
  };

  const handleAddSlot = async () => {
    try {
      await createSlot.mutateAsync({
        timeOfDay: newTime,
        daysOfWeekJson: JSON.stringify(newDays),
        enabled: true
      });
      toast.success("Posting slot added");
      setNewDays([1,2,3,4,5]);
      setNewTime("09:00");
    } catch (err: any) {
      toast.error(`Failed to add slot: ${err.message}`);
    }
  };

  const toggleDayForNew = (idx: number) => {
    setNewDays(prev => 
      prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx]
    );
  };

  const toggleSlotEnabled = async (id: string, enabled: boolean) => {
    try {
      await updateSlot.mutateAsync({ id, data: { enabled } });
    } catch (err: any) {
      toast.error(`Failed to update slot: ${err.message}`);
    }
  };

  const startEditingSlot = (slot: any) => {
    setEditingSlotId(slot.id);
    setEditTime(slot.timeOfDay);
    setEditDays(JSON.parse(slot.daysOfWeekJson || "[]"));
  };

  const cancelEditingSlot = () => {
    setEditingSlotId(null);
  };

  const toggleDayForEdit = (idx: number) => {
    setEditDays(prev =>
      prev.includes(idx) ? prev.filter(d => d !== idx) : [...prev, idx]
    );
  };

  const saveSlotEdit = async (id: string) => {
    if (editDays.length === 0) {
      toast.error("Pick at least one day of the week.");
      return;
    }
    try {
      await updateSlot.mutateAsync({
        id,
        data: { timeOfDay: editTime, daysOfWeekJson: JSON.stringify(editDays) }
      });
      setEditingSlotId(null);
      toast.success("Posting slot updated. New times apply to future queue assignments.");
    } catch (err: any) {
      toast.error(`Failed to update slot: ${err.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />
      
      <main className="flex-1 container max-w-3xl px-4 md:px-8 py-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Settings</h1>
          <p className="text-muted-foreground mt-1">Manage your scheduling rules and connections.</p>
        </div>

        {/* TIMEZONE & DESTINATION */}
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="bg-card border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Timezone</CardTitle>
              <CardDescription>All scheduled times will use this timezone.</CardDescription>
            </CardHeader>
            <CardContent>
              {settingsLoading ? <Skeleton className="h-10 w-full" /> : (
                <Select value={settings?.timezone || "America/Phoenix"} onValueChange={handleTimezoneChange}>
                  <SelectTrigger className="w-full bg-background border-input" data-testid="select-timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map(tz => (
                      <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Facebook Destination</CardTitle>
              <CardDescription>Your Facebook Page ID required by Zernio.</CardDescription>
            </CardHeader>
            <CardContent>
              {settingsLoading ? <Skeleton className="h-10 w-full" /> : (
                <div className="flex gap-2">
                  <Input 
                    value={destinationId} 
                    onChange={e => setDestinationId(e.target.value)} 
                    placeholder="e.g. 1234567890"
                    className="bg-background border-input"
                    data-testid="input-destination-id"
                  />
                  <Button onClick={handleDestinationSave} variant="secondary" data-testid="btn-save-destination">Save</Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ZERNIO CONNECTION */}
        <Card className="bg-card border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Zernio Connection</CardTitle>
            <CardDescription>Verify your connection to the Zernio API.</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {testZernio.isSuccess ? (
                testZernio.data?.connected ? (
                  <Badge variant="outline" className="text-green-500 border-green-500/30 bg-green-500/10 gap-1 px-2 py-1"><CheckCircle2 className="w-3.5 h-3.5"/> Connected</Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/30 bg-destructive/10 gap-1 px-2 py-1"><XCircle className="w-3.5 h-3.5"/> Failed</Badge>
                )
              ) : (
                <span className="text-sm text-muted-foreground">Not tested in this session</span>
              )}
            </div>
            <Button 
              onClick={handleTestConnection} 
              disabled={testZernio.isPending}
              variant="outline"
              data-testid="btn-test-connection"
            >
              {testZernio.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Test Connection
            </Button>
          </CardContent>
        </Card>

        {/* POSTING SCHEDULE */}
        <Card className="bg-card border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">Posting Schedule</CardTitle>
            <CardDescription>Define the times and days when your queue should post.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            
            {/* New Slot Form */}
            <div className="bg-muted/30 p-4 rounded-xl border border-border space-y-4">
              <h4 className="text-sm font-medium text-foreground">Add New Slot</h4>
              <div className="flex flex-col md:flex-row gap-4 items-start md:items-end">
                <div className="space-y-2 w-full md:w-auto">
                  <Label>Time</Label>
                  <Input type="time" value={newTime} onChange={e => setNewTime(e.target.value)} className="bg-background w-full md:w-32" data-testid="input-new-time" />
                </div>
                
                <div className="space-y-2 flex-1 w-full">
                  <Label>Days of Week</Label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS.map((day, idx) => (
                      <div key={day} className="flex items-center space-x-1.5 bg-background border border-border rounded px-2.5 py-1.5">
                        <Checkbox 
                          id={`day-${idx}`} 
                          checked={newDays.includes(idx)} 
                          onCheckedChange={() => toggleDayForNew(idx)}
                          data-testid={`checkbox-new-day-${idx}`}
                        />
                        <label htmlFor={`day-${idx}`} className="text-sm cursor-pointer">{day}</label>
                      </div>
                    ))}
                  </div>
                </div>
                
                <Button onClick={handleAddSlot} className="w-full md:w-auto" disabled={createSlot.isPending} data-testid="btn-add-slot">
                  {createSlot.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
                  Add Slot
                </Button>
              </div>
            </div>

            {/* List Slots */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-foreground">Active Slots</h4>
              {slotsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : slots?.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-xl">
                  No posting slots configured. Your queue will not process.
                </div>
              ) : (
                <div className="grid gap-3">
                  {slots?.map((slot: any) => {
                    const daysArr: number[] = JSON.parse(slot.daysOfWeekJson || "[]");
                    const isEditingSlot = editingSlotId === slot.id;

                    if (isEditingSlot) {
                      return (
                        <div key={slot.id} className="bg-background border border-primary/40 p-4 rounded-lg space-y-4" data-testid={`slot-edit-${slot.id}`}>
                          <div className="flex flex-col md:flex-row gap-4 items-start md:items-end">
                            <div className="space-y-2 w-full md:w-auto">
                              <Label>Time</Label>
                              <Input
                                type="time"
                                value={editTime}
                                onChange={e => setEditTime(e.target.value)}
                                className="bg-background w-full md:w-32"
                                data-testid={`input-edit-time-${slot.id}`}
                              />
                            </div>
                            <div className="space-y-2 flex-1 w-full">
                              <Label>Days of Week</Label>
                              <div className="flex flex-wrap gap-2">
                                {DAYS.map((day, idx) => (
                                  <div key={day} className="flex items-center space-x-1.5 bg-background border border-border rounded px-2.5 py-1.5">
                                    <Checkbox
                                      id={`edit-day-${slot.id}-${idx}`}
                                      checked={editDays.includes(idx)}
                                      onCheckedChange={() => toggleDayForEdit(idx)}
                                      data-testid={`checkbox-edit-day-${slot.id}-${idx}`}
                                    />
                                    <label htmlFor={`edit-day-${slot.id}-${idx}`} className="text-sm cursor-pointer">{day}</label>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" onClick={cancelEditingSlot} disabled={updateSlot.isPending} data-testid={`btn-cancel-edit-slot-${slot.id}`}>
                              <X className="w-4 h-4 mr-1.5" /> Cancel
                            </Button>
                            <Button size="sm" onClick={() => saveSlotEdit(slot.id)} disabled={updateSlot.isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid={`btn-save-edit-slot-${slot.id}`}>
                              {updateSlot.isPending ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
                              Save Changes
                            </Button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={slot.id} className="flex items-center justify-between bg-background border border-border p-3 rounded-lg" data-testid={`slot-${slot.id}`}>
                        <div className="flex items-center gap-4">
                          <div className="flex items-center gap-2 font-mono text-lg font-medium text-primary">
                            <Clock className="w-5 h-5 text-muted-foreground" />
                            {slot.timeOfDay}
                          </div>
                          <div className="hidden sm:flex flex-wrap gap-1">
                            {DAYS.map((day, idx) => (
                              <span key={day} className={`text-xs px-1.5 py-0.5 rounded ${daysArr.includes(idx) ? 'bg-accent/20 text-accent-foreground font-medium' : 'text-muted-foreground opacity-50'}`}>
                                {day}
                              </span>
                            ))}
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-4">
                          <div className="flex items-center space-x-2">
                            <Switch 
                              checked={slot.enabled} 
                              onCheckedChange={(val) => toggleSlotEnabled(slot.id, val)}
                              data-testid={`switch-slot-${slot.id}`}
                            />
                            <Label className="text-xs text-muted-foreground hidden sm:inline-block">{slot.enabled ? 'Active' : 'Paused'}</Label>
                          </div>

                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => startEditingSlot(slot)}
                            className="text-muted-foreground hover:text-foreground h-8 w-8"
                            title="Edit time and days"
                            data-testid={`btn-edit-slot-${slot.id}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>

                          <Button 
                            variant="ghost" 
                            size="icon" 
                            onClick={() => deleteSlot.mutate(slot.id)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10 h-8 w-8"
                            data-testid={`btn-delete-slot-${slot.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

      </main>
    </div>
  );
}

// Temporary badge component for inline use
function Badge({ className, variant, ...props }: any) {
  return <div className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${className}`} {...props} />;
}
