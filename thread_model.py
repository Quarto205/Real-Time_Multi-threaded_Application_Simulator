# app/models/thread_model.py
class ThreadModel:
    """
    Pure Data Class representing a single OS Thread.
    Holds state, timing info, and execution history.
    """
    def __init__(self, t_id, burst, priority, arrival_time, color):
        self.id = t_id
        self.burst_time = burst
        self.remaining_time = burst
        self.priority = priority
        self.state = "NEW"  
        self.color = color
        self.arrival_time = arrival_time
        self.cpu_id = -1 
        self.queue_sequence = 0
        self.waiting_time = 0
        self.turnaround_time = 0
        self.history = []